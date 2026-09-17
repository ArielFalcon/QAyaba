/* src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts ValueOraclePort for the CODE target. Signal-only by contract: a null valueScore never gates publish. The process-tree kill on the hang/timeout path is injected via ProcessKillPort (shared-kernel) rather than a local byte-copy — this was the last of the 4 killTree duplicates named in process-kill.port.ts's consolidation note (execute.ts, code-runner.ts, static-signal/exec.ts, learning/mutation-code.ts); ProcessKillAdapter (shared-infrastructure) is the one concrete implementation, same as sandboxed-binary-runner.adapter.ts's usage. `timeoutMs` is also injected (ctor-level, defaulting to DEFAULT_MUTATION_TIMEOUT_MS) so the hang/timeout path is testable against the real adapter without waiting out the 600s production default. */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";

const DEFAULT_MUTATION_TIMEOUT_MS = 600_000;

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

function writeStrykerConfig(repoDir: string, testCommand: string, testArgs: string[], mutate: string[]): string {
  const configPath = join(repoDir, "stryker.conf.json");
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
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function parseStrykerReport(repoDir: string): { mutationScore: number; mutantCount: number; killedCount: number } | null {
  const reportPath = join(repoDir, "reports", "mutation", "mutation.json");
  if (!existsSync(reportPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(reportPath, "utf8"));
    const score = raw.metrics?.mutationScore;
    const killed = raw.metrics?.killed;
    const total = raw.metrics?.totalMutants;
    if (typeof score !== "number" || typeof killed !== "number" || typeof total !== "number") return null;
    return { mutationScore: score, mutantCount: total, killedCount: killed };
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
      return Promise.resolve({
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
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
        mutantCount: 0,
        killedCount: 0,
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

      let stdout = "";
      let stderr = "";
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
          mutantCount: 0,
          killedCount: 0,
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
              mutantCount: 0,
              killedCount: 0,
              details: "mutation testing aborted by operator cancel",
            });
          },
          { once: true },
        );
      }

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

      child.on("error", (err) => {
        finish({
          valueScore: null,
          mutantCount: 0,
          killedCount: 0,
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
            mutantCount: 0,
            killedCount: 0,
            details: `Stryker ran but produced no parseable report. Last output: ${(stderr || stdout).slice(0, 300)}`,
          });
        }
      });
    });
  }
}
