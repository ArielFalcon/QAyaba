/*
 * Copies the human labels made in Langfuse (annotation queues) into the run store.
 *
 *   npm run langfuse:labels -- (--session <id> | --since <ISO date>) [--name <score>] [--dry-run]
 *
 * A label is a Langfuse score with source ANNOTATION. Each one on a trace of a run this orchestrator recorded becomes a
 * `source=human` row of that run in `run_scores` (grader version `human`), beside the grader's score of the same name. The grader
 * calibration reads those rows, so it never depends on Langfuse being up: run this while Langfuse is, and the labels are kept.
 * Idempotent: a row is keyed by (run, name, `human`), and the latest annotation of a score on a run wins. `--session` takes the
 * traces of one Langfuse session (a campaign, or an app); `--since` takes every annotation from a date on.
 *
 * It writes the orchestrator's run history, so run it inside the orchestrator container, as the other operator scripts.
 * Nothing in the service calls it. The project keys come from LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.
 */
import { pathToFileURL } from "node:url";
import { MAX_SCORE_COMMENT_CHARS, specOfScore } from "../qa-engine/src/contexts/evaluation/domain/grader-catalog.ts";
import type { ScoreDataType, ScorePolarity } from "../qa-engine/src/contexts/evaluation/domain/score.ts";

export type Parsed = { ok: true; session?: string; since?: string; name?: string; dryRun: boolean } | { ok: false; problem: string };

export function parseArguments(argv: readonly string[]): Parsed {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session" || a === "--since" || a === "--name") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
      values[a] = v;
    } else if (a === "--dry-run") dryRun = true;
    else return { ok: false, problem: `error: unknown argument ${a}` };
  }
  if (!values["--session"]?.trim() && !values["--since"]?.trim()) return { ok: false, problem: "error: --session or --since is required" };
  return {
    ok: true,
    ...(values["--session"] ? { session: values["--session"] } : {}),
    ...(values["--since"] ? { since: values["--since"] } : {}),
    ...(values["--name"] ? { name: values["--name"] } : {}),
    dryRun,
  };
}

const USAGE = [
  "usage: npm run langfuse:labels -- (--session <id> | --since <ISO date>) [--name <score>] [--dry-run]",
  "  Copies Langfuse annotation scores (human labels) of runs this orchestrator recorded into run_scores as source=human rows.",
  "  Idempotent. --dry-run counts and writes nothing. Needs LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY.",
].join("\n");

export interface LabelRow {
  runId: string;
  name: string;
  graderVersion: "human";
  dataType: ScoreDataType;
  polarity: ScorePolarity;
  source: "human";
  value: number | boolean | string;
  comment: string | null;
  observationId: string | null;
}

export interface LabelDeps {
  config: { baseUrl: string; publicKey: string; secretKey: string };
  runIdOfTrace: (traceId: string) => string | undefined;
  save: (rows: readonly LabelRow[], at: string) => void;
  sanitize: (text: string) => string;
  now: () => string;
  out: (line: string) => void;
  fetch?: typeof fetch;
}

export interface LabelFilter {
  session?: string;
  since?: string;
  name?: string;
}

export interface LabelResult {
  fetched: number;
  imported: number;
  /* Annotations on a trace of another session, or of no run in this store. */
  unmatched: number;
  /* Annotations of a data type a run score cannot hold (free text, corrections). */
  unsupported: number;
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 1_000;
const TIMEOUT_MS = 30_000;

interface Page<T> {
  data?: T[];
  meta?: { totalPages?: number };
}

async function pages<T>(deps: LabelDeps, path: string, params: Record<string, string>): Promise<T[]> {
  const auth = `Basic ${Buffer.from(`${deps.config.publicKey}:${deps.config.secretKey}`).toString("base64")}`;
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ ...params, page: String(page), limit: String(PAGE_LIMIT) });
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(`${deps.config.baseUrl}${path}?${query}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`GET ${path}: ${keyless(deps, error instanceof Error ? error.message : String(error))}`);
    }
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    const body = (await response.json()) as Page<T>;
    out.push(...(body.data ?? []));
    if (page >= (body.meta?.totalPages ?? 1)) break;
  }
  return out;
}

/* Neither key is ever printed, whatever a transport error echoes. */
function keyless(deps: LabelDeps, text: string): string {
  return [deps.config.secretKey, deps.config.publicKey].reduce((acc, key) => (key ? acc.split(key).join("[redacted]") : acc), text);
}

interface LangfuseScore {
  id?: string;
  traceId?: string | null;
  observationId?: string | null;
  name?: string;
  value?: number | null;
  stringValue?: string | null;
  dataType?: string;
  comment?: string | null;
  timestamp?: string;
}

/* Reads the annotations and, unless `dryRun`, stores them. The counts are the same either way. */
export async function importLabels(deps: LabelDeps, filter: LabelFilter, opts: { dryRun?: boolean } = {}): Promise<LabelResult> {
  const sessionTraces = filter.session ? new Set((await pages<{ id?: string }>(deps, "/api/public/traces", { sessionId: filter.session })).flatMap((t) => (t.id ? [t.id] : []))) : undefined;
  const scores = await pages<LangfuseScore>(deps, "/api/public/v2/scores", {
    source: "ANNOTATION",
    ...(filter.since ? { fromTimestamp: filter.since } : {}),
    ...(filter.name ? { name: filter.name } : {}),
  });
  const result: LabelResult = { fetched: scores.length, imported: 0, unmatched: 0, unsupported: 0 };
  const latest = new Map<string, { row: LabelRow; at: string }>();
  for (const score of scores) {
    const runId = score.traceId && (!sessionTraces || sessionTraces.has(score.traceId)) ? deps.runIdOfTrace(score.traceId) : undefined;
    if (!runId || !score.name) {
      result.unmatched += 1;
      continue;
    }
    const typed = typedValue(score);
    if (typed === undefined) {
      result.unsupported += 1;
      continue;
    }
    const spec = specOfScore(score.name);
    const row: LabelRow = {
      runId,
      name: score.name,
      graderVersion: "human",
      dataType: typed.dataType,
      polarity: spec?.polarity ?? "none",
      source: "human",
      value: typed.value,
      comment: score.comment ? deps.sanitize(score.comment).slice(0, MAX_SCORE_COMMENT_CHARS) : null,
      observationId: score.observationId ?? null,
    };
    const key = `${runId}\u0000${score.name}`;
    const at = score.timestamp ?? "";
    const kept = latest.get(key);
    if (!kept || at >= kept.at) latest.set(key, { row, at });
  }
  const rows = [...latest.values()].map((entry) => entry.row);
  result.imported = rows.length;
  if (rows.length > 0 && !opts.dryRun) deps.save(rows, deps.now());
  return result;
}

function typedValue(score: LangfuseScore): { dataType: ScoreDataType; value: number | boolean | string } | undefined {
  if (score.dataType === "NUMERIC" && typeof score.value === "number" && Number.isFinite(score.value)) return { dataType: "NUMERIC", value: score.value };
  if (score.dataType === "BOOLEAN" && (score.value === 0 || score.value === 1)) return { dataType: "BOOLEAN", value: score.value === 1 };
  if (score.dataType === "CATEGORICAL" && typeof score.stringValue === "string" && score.stringValue !== "") return { dataType: "CATEGORICAL", value: score.stringValue };
  return undefined;
}

/** Returns the process exit code. A bad argument prints the usage and returns 2; anything the import could not do throws. */
export async function main(argv: readonly string[], deps: LabelDeps): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    deps.out(USAGE);
    return 2;
  }
  const result = await importLabels(deps, { ...(parsed.session ? { session: parsed.session } : {}), ...(parsed.since ? { since: parsed.since } : {}), ...(parsed.name ? { name: parsed.name } : {}) }, { dryRun: parsed.dryRun });
  const detail = `${result.fetched} annotation(s) read; ${result.unmatched} on no known run or session trace; ${result.unsupported} of an unsupported type`;
  if (parsed.dryRun) {
    deps.out(`dry run: ${result.imported} label(s) would be imported (${detail}); nothing was written`);
    return 0;
  }
  deps.out(`imported ${result.imported} label(s) (${detail})`);
  return 0;
}

/** The run history and the Langfuse keys of the orchestrator container, imported lazily so a test that injects its own never opens them. */
export async function defaultDeps(): Promise<LabelDeps> {
  const { resolveLangfuseConfig } = await import("../src/telemetry/langfuse-score-sink.ts");
  const config = resolveLangfuseConfig(process.env);
  if (!config) throw new Error("LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must all be set");
  const { getRunIdByTraceId, replaceRunScores } = await import("../src/server/history.ts");
  const { RedactionPortAdapter } = await import("../src/orchestrator/sanitizer.ts");
  const redaction = new RedactionPortAdapter();
  return {
    config,
    runIdOfTrace: getRunIdByTraceId,
    save: (rows, at) => replaceRunScores(rows, at),
    sanitize: (text) => redaction.redact(text),
    now: () => new Date().toISOString(),
    out: (line) => console.log(line),
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  defaultDeps()
    .then((deps) => main(process.argv.slice(2), deps))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
