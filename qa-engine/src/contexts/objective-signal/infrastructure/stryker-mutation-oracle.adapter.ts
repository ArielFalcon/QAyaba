/* src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts ValueOraclePort for the CODE target. Signal-only by contract: a null valueScore never gates publish. The process-tree kill on the hang/timeout path is injected via ProcessKillPort (shared-kernel) rather than a local byte-copy — this was the last of the 4 killTree duplicates named in process-kill.port.ts's consolidation note (execute.ts, code-runner.ts, static-signal/exec.ts, learning/mutation-code.ts); ProcessKillAdapter (shared-infrastructure) is the one concrete implementation, same as sandboxed-binary-runner.adapter.ts's usage. `timeoutMs` is also injected (ctor-level, defaulting to DEFAULT_MUTATION_TIMEOUT_MS) so the hang/timeout path is testable against the real adapter without waiting out the 600s production default. */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import { BoundedOutputTail } from "@kernel/process-sandbox/bounded-output-tail.ts";
import { readFailureReason, readOwnedSpecFile, writeOwnedSpecFile } from "../../../shared-infrastructure/spec-path-confinement.ts";

const DEFAULT_MUTATION_TIMEOUT_MS = 600_000;

/* What is kept of each output stream of a Stryker run. Only the last few hundred chars are ever reported, and the run executes the repo's own tests, so its output is untrusted and may be unbounded. */
export const MUTATION_OUTPUT_KEEP_CHARS = 8_000;

/* Stryker's JSON report holds a record for every mutant with where it is and what it became: some megabytes for a real repository, and far from this. The report is left by a run of the repository's own tests, which the agent wrote. */
export const MAX_MUTATION_REPORT_BYTES = 128 * 1024 * 1024;

export function resolveStrykerCommand(): { cmd: string; args: string[] } {
  const root = process.env.QAYABA_ROOT ?? process.cwd();
  const bin = join(root, "node_modules", ".bin", "stryker");
  if (existsSync(bin)) return { cmd: bin, args: ["run"] };
  return { cmd: "npx", args: ["stryker", "run"] };
}

function sourceGlobs(repoDir: string): string[] {
  const candidates = [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.js",
    "src/**/*.jsx",
    "lib/**/*.ts",
    "lib/**/*.js",
    "app/**/*.ts",
    "app/**/*.tsx",
  ];
  return candidates.filter((g) => {
    const base = g.split("/")[0];
    return base && existsSync(join(repoDir, base));
  });
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx)$/;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/;

export function selectMutateTargets(repoDir: string, changedFiles?: string[]): string[] {
  if (changedFiles && changedFiles.length > 0) {
    const scoped = changedFiles.filter(
      (f) => SOURCE_EXT.test(f) && !TEST_FILE.test(f) && existsSync(join(repoDir, f)),
    );
    if (scoped.length > 0) return scoped;
  }
  const globs = sourceGlobs(repoDir);
  return globs.length > 0 ? globs : ["src/**/*.ts", "src/**/*.js"];
}

/* The config goes into the repository's working copy, which the agent writes into: it is replaced through a temporary file renamed over the target, so a link planted at `stryker.conf.json` is never written through. A name the strict write refuses is thrown, and the run is unmeasured. */
function writeStrykerConfig(repoDir: string, testCommand: string, testArgs: string[], mutate: string[]): void {
  const config = {
    $schema: "https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/core/schema/stryker-schema.json",
    mutate,
    testRunner: "command",
    commandRunner: {
      command: [testCommand, ...testArgs].join(" "),
    },
    reporters: ["json", "clear-text"],
    jsonReportFile: "reports/mutation/mutation.json",
    thresholds: { high: 100, low: 0, break: null },
    timeoutMS: 30000,
    disableTypeChecks: `${testCommand} ${testArgs.join(" ")}`.includes("tsc") ? false : true,
    cleanTempDir: true,
    tempDirName: ".stryker-tmp",
  };
  writeOwnedSpecFile({ mirrorDir: repoDir, specDir: repoDir }, "stryker.conf.json", JSON.stringify(config, null, 2));
}

/* A report that was there and cannot be used: said aloud with the reason of the module's own and nothing the report held. */
function unread(reason: string): null {
  console.warn(`[qa] WARNING: the Stryker report was not read (${reason}); the mutation score stays unmeasured (non-blocking).`);
  return null;
}

/* The run's report, read strictly and under a cap: Stryker ran the repository's own tests, so a named pipe, a link or a file of any size can be where the report should be. One that cannot be used is a run that produced none. A report that is not JSON, or that lacks a metric, is none either (the parse is inside the try). */
function parseStrykerReport(repoDir: string): { mutationScore: number; mutantCount: number; killedCount: number } | null {
  let read: ReturnType<typeof readOwnedSpecFile>;
  try {
    read = readOwnedSpecFile({ mirrorDir: repoDir, specDir: repoDir }, "reports/mutation/mutation.json", MAX_MUTATION_REPORT_BYTES);
  } catch (err) {
    return unread(readFailureReason(err));
  }
  if ("absent" in read) return null;
  if ("reason" in read) return unread(read.reason);
  try {
    const { mutationScore, killed, totalMutants } = JSON.parse(read.bytes.toString("utf8")).metrics;
    if (typeof mutationScore !== "number" || typeof killed !== "number" || typeof totalMutants !== "number") return null;
    return { mutationScore, mutantCount: totalMutants, killedCount: killed };
  } catch {
    return null;
  }
}

function cleanupStryker(repoDir: string): void {
  try {
    rmSync(join(repoDir, "stryker.conf.json"), { force: true });
    rmSync(join(repoDir, "reports"), { recursive: true, force: true });
    rmSync(join(repoDir, ".stryker-tmp"), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

interface OracleInputLike {
  target: "code";
  repoDir: string;
  namespace: string;
  changedFiles?: string[];
  ecosystem?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

interface CodeProjectLike {
  ecosystem: string;
  test: { cmd: string; args: string[] };
}

export interface MutationOracleDeps {
  spawn(
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; detached: boolean },
  ): ChildProcess;
  detectCodeProject(repoDir: string): CodeProjectLike;
  scrubEnv(): Record<string, string>;
  /* The consolidated killTree seam (shared-kernel ProcessKillPort) — required, not optional: every caller (production via rewritten-engine-factory.ts, tests via the adapter test's `deps()` builder) supplies a real implementation, matching sandboxed-binary-runner.adapter.ts's pattern. */
  processKill: ProcessKillPort;
  timeoutMs?: number;
}

export class StrykerMutationOracleAdapter implements ValueOraclePort {
  constructor(private readonly deps: MutationOracleDeps) {}

  async measure(br: BlastRadius, repoDir: string, namespace: string, _baselineCases?: string[]): Promise<ValueOracleResult> {
    return this.runMutationOracle({
      target: "code",
      repoDir,
      namespace,
      changedFiles: [...br.changedFiles],
      timeoutMs: this.deps.timeoutMs,
    });
  }

  private ecosystemForRepo(repoDir: string): string | null {
    try {
      return this.deps.detectCodeProject(repoDir).ecosystem;
    } catch {
      return null;
    }
  }

  private runMutationOracle(input: OracleInputLike): Promise<ValueOracleResult> {
    const eco = input.ecosystem ?? this.ecosystemForRepo(input.repoDir);

    if (eco !== "node") {
      /* null, not 0, for every "not measured" branch below — never a fabricated zero mutant/kill count. */
      return Promise.resolve({
        valueScore: null,
        mutantCount: null,
        killedCount: null,
        details: `mutation testing not available for ecosystem "${eco ?? "unknown"}" (only JS/TS via Stryker is supported)`,
      });
    }

    const project = this.deps.detectCodeProject(input.repoDir);
    const testCmd = project.test.cmd;
    const testArgs = project.test.args;

    try {
      writeStrykerConfig(input.repoDir, testCmd, testArgs, selectMutateTargets(input.repoDir, input.changedFiles));
    } catch (err) {
      return Promise.resolve({
        valueScore: null,
        mutantCount: null,
        killedCount: null,
        details: `failed to write Stryker config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;

    return new Promise((resolve) => {
      const { cmd, args } = resolveStrykerCommand();
      const child = this.deps.spawn(cmd, args, {
        cwd: input.repoDir,
        env: this.deps.scrubEnv(),
        detached: true,
      });

      const stdout = new BoundedOutputTail(MUTATION_OUTPUT_KEEP_CHARS);
      const stderr = new BoundedOutputTail(MUTATION_OUTPUT_KEEP_CHARS);
      let settled = false;

      if (input.onProgress && child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            const trimmed = line.trim();
            if (trimmed) input.onProgress!(trimmed);
          }
        });
      }

      const finish = (result: ValueOracleResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupStryker(input.repoDir);
        resolve(result);
      };

      const timer = setTimeout(() => {
        this.deps.processKill.killTree(child);
        finish({
          valueScore: null,
          mutantCount: null,
          killedCount: null,
          details: `mutation testing timeout after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      if (input.signal) {
        input.signal.addEventListener(
          "abort",
          () => {
            this.deps.processKill.killTree(child);
            finish({
              valueScore: null,
              mutantCount: null,
              killedCount: null,
              details: "mutation testing aborted by operator cancel",
            });
          },
          { once: true },
        );
      }

      child.stdout?.on("data", (d: Buffer) => stdout.append(d.toString()));
      child.stderr?.on("data", (d: Buffer) => stderr.append(d.toString()));

      child.on("error", (err) => {
        finish({
          valueScore: null,
          mutantCount: null,
          killedCount: null,
          details: `mutation testing spawn failed: ${err.message}`,
        });
      });

      child.on("close", () => {
        const report = parseStrykerReport(input.repoDir);
        if (report) {
          const score = report.mutationScore / 100;
          finish({
            valueScore: Math.round(score * 1000) / 1000,
            mutantCount: report.mutantCount,
            killedCount: report.killedCount,
            details: `${report.killedCount}/${report.mutantCount} mutants killed (${report.mutationScore.toFixed(1)}%)`,
          });
        } else {
          finish({
            valueScore: null,
            mutantCount: null,
            killedCount: null,
            details: `Stryker ran but produced no parseable report. Last output: ${(stderr.text() || stdout.text()).slice(-300)}`,
          });
        }
      });
    });
  }
}
