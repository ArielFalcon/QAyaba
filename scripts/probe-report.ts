/*
 * What a pipeline run did and what it cost, in the metrics shape both arms of the pipeline-vs-plain-agent
 * experiment share (scripts/probe-metrics.ts). Run it inside the orchestrator container, where the run
 * history lives, right after the run (the working copy still holds the specs then):
 *
 *   npm run probe-report -- <runId...> [--json] [--out-dir DIR]
 *
 * Prints a markdown table of the runs and one of their agent turns, and writes each run's full report
 * (with the ordered tool sequence of every turn) to config/benchmarks/probe-results/<runId>.json
 * (gitignored: run ids and numbers only). Read-only: it changes nothing in the history, the working
 * copies or the service. A figure the run did not record reads `n/a`; a run older than the columns
 * it needs reports those as unknown, never zero.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunEventBody } from "@kernel/contract/events.ts";
import { readConfinedSpecFile } from "../qa-engine/src/shared-infrastructure/spec-path-confinement.ts";
import type { AgentTurnRecord } from "../src/server/history.ts";
import type { RunOutcome, RunRecord } from "../src/types.ts";
import { buildPipelineReport, renderMarkdown, type ProbeReport, type TimedRunEvent } from "./probe-metrics.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where reports are written (gitignored). */
export function defaultProbeResultsDir(): string {
  return join(ROOT, "config", "benchmarks", "probe-results");
}

/** Change-coverage's default minimum ratio, as the composition root applies it when an app states none. */
export const DEFAULT_COVERAGE_MIN_RATIO = 0.7;

/* An id names a file, so it must not be able to escape the results directory. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertFileName(name: string, what: string): void {
  if (!FILE_NAME_PATTERN.test(name)) throw new Error(`invalid ${what} '${name}' — use letters, digits, '.', '_' or '-' (starting with a letter or digit)`);
}

/** Publishes the content by renaming a finished temporary file over the target, so a crash never leaves a half-written report. */
export function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

/** Where a run's recorded data is read from: the orchestrator's history in the container, a fake in tests. */
export interface ReportDeps {
  events(runId: string): TimedRunEvent[];
  outcome(runId: string): RunOutcome | undefined;
  record(runId: string): RunRecord | undefined;
  turns(runId: string): AgentTurnRecord[];
  /** The files the change touched, or null when they could not be read. */
  changedFiles(record: RunRecord): Promise<string[] | null>;
  /** The line count of each reported spec still on disk; a spec that is gone is null. */
  specLines(record: RunRecord, reported: readonly string[]): Map<string, number | null>;
  /** The change-coverage minimum of the run's app. */
  minRatio(record: RunRecord): number;
}

const reportedSpecPaths = (record: RunRecord | undefined, events: readonly TimedRunEvent[]): string[] => {
  const paths = new Set<string>();
  for (const s of record?.specs ?? []) paths.add(s.name);
  for (const e of events) if (e.body.type === "spec.written") paths.add(e.body.file);
  return [...paths];
};

/** One run's report. Throws when the run is unknown to the history (no record, outcome or event). */
export async function collectReport(runId: string, deps: ReportDeps): Promise<ProbeReport> {
  const record = deps.record(runId);
  const outcome = deps.outcome(runId);
  const events = deps.events(runId);
  if (!record && !outcome && events.length === 0) throw new Error(`run ${runId} is not in the history (unknown id, or its records are older than the retention window)`);
  return buildPipelineReport({
    runId,
    record,
    outcome,
    events,
    turns: deps.turns(runId),
    changedFiles: record ? await deps.changedFiles(record) : null,
    specLines: record ? deps.specLines(record, reportedSpecPaths(record, events)) : new Map(),
    minRatio: record ? deps.minRatio(record) : DEFAULT_COVERAGE_MIN_RATIO,
  });
}

/* ── the real collaborators ────────────────────────────────────────────────────────── */

const countLines = (text: string): number => (text === "" ? 0 : text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length);

/** The history, the app configs and the mirrors of the orchestrator container, imported lazily so a test that injects its own never opens them. */
export async function defaultReportDeps(warn: (line: string) => void = (l) => console.error(l)): Promise<ReportDeps> {
  const history = await import("../src/server/history.ts");
  const { loadAppConfig } = await import("../src/orchestrator/config-loader.ts");
  const { workdirRoot, realGit } = await import("../src/integrations/repo-mirror.ts");

  const appOf = (record: RunRecord) => {
    try {
      return loadAppConfig(record.app);
    } catch (err) {
      warn(`[probe] app '${record.app}' could not be loaded (${err instanceof Error ? err.message : String(err)}): its diff, spec sizes and coverage policy are unknown`);
      return undefined;
    }
  };
  const mirrorOf = (repo: string): string => join(workdirRoot(), repo.replaceAll("/", "__"));

  return {
    events: (runId) => history.loadRunEvents(runId).map((e) => ({ ts: e.ts, body: e.body as RunEventBody })),
    outcome: (runId) => history.getRunOutcome(runId),
    record: (runId) => history.getRecord(runId),
    turns: (runId) => history.getAgentTurns(runId),
    changedFiles: async (record) => {
      const app = appOf(record);
      if (!app) return null;
      /* A cross-repo run's diff is the service repo's. */
      const repo = record.triggerRepo ?? app.repo;
      try {
        const out = await realGit(["show", "--format=", "--name-only", "-m", "--first-parent", record.sha], mirrorOf(repo));
        return out.split("\n").map((l) => l.trim()).filter(Boolean);
      } catch (err) {
        warn(`[probe] the diff of ${record.sha} could not be read from the mirror of ${repo} (${err instanceof Error ? err.message : String(err)}): reads outside the diff are unknown`);
        return null;
      }
    },
    specLines: (record, reported) => {
      const lines = new Map<string, number | null>();
      const app = appOf(record);
      if (!app) return lines;
      const mirrorDir = mirrorOf(app.repo);
      const root = { mirrorDir, specDir: join(mirrorDir, "e2e") };
      for (const path of reported) {
        lines.set(path, null);
        /* The agent named this path, so it is read only through the confined reader. A name may be spec-directory relative or carry the directory. */
        for (const candidate of [path, path.replace(/^e2e\//, "")]) {
          try {
            lines.set(path, countLines(readConfinedSpecFile(root, candidate)));
            break;
          } catch {
            /* try the next spelling; a spec that is gone stays unknown */
          }
        }
      }
      return lines;
    },
    minRatio: (record) => appOf(record)?.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_MIN_RATIO,
  };
}

/* ── command line ──────────────────────────────────────────────────────────────────── */

const USAGE = [
  "usage: npm run probe-report -- <runId...> [--json] [--out-dir DIR]",
  "  prints a markdown table per run (phases, verdict, specs, coverage, reviewer) and per agent turn (calls, time to first write, denied calls, tokens, cost, where it read)",
  "  --json     print the reports as JSON instead of markdown",
  "  --out-dir  where each run's full report is written as <runId>.json (default config/benchmarks/probe-results)",
  "run inside the orchestrator container: it reads the run history and the working copies.",
].join("\n");

export interface MainOptions {
  deps?: ReportDeps;
  out?: (line: string) => void;
  outDir?: string;
}

type Parsed = { ok: true; runIds: string[]; json: boolean; outDir?: string } | { ok: false; problem: string };

function parseArguments(args: readonly string[]): Parsed {
  const runIds: string[] = [];
  let json = false;
  let outDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--out-dir") {
      const v = args[++i];
      if (!v) return { ok: false, problem: "error: --out-dir needs a directory" };
      outDir = v;
    } else if (a.startsWith("--")) return { ok: false, problem: `error: unknown option ${a}` };
    else runIds.push(a);
  }
  if (runIds.length === 0) return { ok: false, problem: "error: name at least one run id" };
  return { ok: true, runIds, json, ...(outDir ? { outDir } : {}) };
}

/** Returns the process exit code: 0 ok, 1 a run could not be reported, 2 bad usage. */
export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    out(parsed.problem);
    for (const line of USAGE.split("\n")) out(line);
    return 2;
  }
  try {
    for (const id of parsed.runIds) assertFileName(id, "run id");
    const deps = opts.deps ?? (await defaultReportDeps());
    const outDir = parsed.outDir ?? opts.outDir ?? defaultProbeResultsDir();
    const reports: ProbeReport[] = [];
    let failed = false;
    for (const id of parsed.runIds) {
      try {
        const report = await collectReport(id, deps);
        reports.push(report);
        writeJsonAtomically(join(outDir, `${id}.json`), report);
      } catch (err) {
        failed = true;
        out(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (reports.length > 0) {
      const text = parsed.json ? JSON.stringify(reports, null, 2) : renderMarkdown(reports);
      for (const line of text.split("\n")) out(line);
      if (!parsed.json) out(`\nfull reports (with every turn's tool sequence): ${outDir}/<runId>.json`);
    }
    return failed ? 1 : 0;
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
