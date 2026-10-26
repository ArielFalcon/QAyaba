/*
 * Labels one run by hand, without Langfuse: what a person needs to judge it, then the label they give.
 *
 *   npm run label -- --run <id> --show
 *   npm run label -- --run <id> --name <score> --value <value> [--comment <text>]
 *
 * `--show` prints the run's commit and verdict, the flows of the plan it kept (objective, acceptance, the change pages each visits,
 * how it ended), the specs it delivered with their test titles, the use cases the reference set holds for its commit
 * (`config/benchmarks/use-cases/*.json`, docs/observability-design.md §11.3) and the judges' scores with their critiques. The label is
 * a `source=human` row of the run in `run_scores` (grader version `human`), typed by the catalog or by the judge of that name, the
 * same row `npm run langfuse:labels` writes: the latest label of a score on a run wins, and `npm run judge-calibrate` pairs it with
 * the judge's score of the same run.
 *
 * It reads and writes the orchestrator's run history, so run it inside the orchestrator container, as the other operator scripts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_SCORE_COMMENT_CHARS, specOfScore } from "../qa-engine/src/contexts/evaluation/application/index.ts";
import { judgeLabelSpec } from "../qa-engine/src/contexts/evaluation/application/index.ts";
import { parseUseCaseReference, referenceFor, type UseCaseReference } from "../qa-engine/src/contexts/evaluation/application/index.ts";
import type { LabelRow } from "./langfuse-labels.ts";

export const USE_CASES_DIR = "config/benchmarks/use-cases";

export type Parsed =
  | { ok: true; runId: string; show: true }
  | { ok: true; runId: string; show: false; name: string; value: string; comment?: string }
  | { ok: false; problem: string };

const USAGE = [
  "usage: npm run label -- --run <id> --show",
  "       npm run label -- --run <id> --name <score> --value <value> [--comment <text>]",
  "  A BOOLEAN score (a binary judge's) takes pass or fail; a CATEGORICAL one a member of its set; a NUMERIC one a number in its range.",
].join("\n");

export function parseArguments(argv: readonly string[]): Parsed {
  const values: Record<string, string> = {};
  let show = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--run" || a === "--name" || a === "--value" || a === "--comment") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
      values[a] = v;
    } else if (a === "--show") show = true;
    else return { ok: false, problem: `error: unknown argument ${a}` };
  }
  const runId = values["--run"]?.trim();
  if (!runId) return { ok: false, problem: "error: --run is required" };
  if (show) return values["--name"] || values["--value"] ? { ok: false, problem: "error: --show takes no label" } : { ok: true, runId, show: true };
  if (!values["--name"] || values["--value"] === undefined) return { ok: false, problem: "error: --name and --value are required (or --show)" };
  return { ok: true, runId, show: false, name: values["--name"], value: values["--value"], ...(values["--comment"] ? { comment: values["--comment"] } : {}) };
}

export interface LabelRunDeps {
  getRecord(id: string): { app: string; sha: string; verdict?: string; cases: ReadonlyArray<{ name: string; status: string; file?: string }> } | undefined;
  getRunPlan(id: string): string | undefined;
  /* The newest text of each spec the run delivered. */
  deliveredSpecs(id: string): Array<{ path: string; text: string }>;
  scores(id: string): ReadonlyArray<{ name: string; source: string; value: number | boolean | string; comment: string | null }>;
  references(): UseCaseReference[];
  save(rows: readonly LabelRow[], at: string): void;
  sanitize(text: string): string;
  now(): string;
  out(line: string): void;
}

/* The titles of a spec's tests, as `test("…")` names them. */
export function testTitles(text: string): string[] {
  return [...text.matchAll(/\btest(?:\.(?:only|skip|fixme|fail))?\(\s*(["'`])((?:(?!\1).){1,200})\1/g)].map((m) => m[2]!);
}

/* The label's value as the score's type takes it, or why not. */
function typedValue(spec: { dataType: string; range?: { min: number; max?: number }; categories?: readonly string[] }, raw: string): { value: number | boolean | string } | { problem: string } {
  if (spec.dataType === "BOOLEAN") {
    if (raw === "pass" || raw === "true") return { value: true };
    if (raw === "fail" || raw === "false") return { value: false };
    return { problem: "a BOOLEAN label is pass or fail" };
  }
  if (spec.dataType === "NUMERIC") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return { problem: "a NUMERIC label is a number" };
    if (spec.range && (n < spec.range.min || (spec.range.max !== undefined && n > spec.range.max))) return { problem: `out of range ${spec.range.min}..${spec.range.max ?? "∞"}` };
    return { value: n };
  }
  if (spec.categories && !spec.categories.includes(raw)) return { problem: `not one of ${spec.categories.join(", ")}` };
  return raw === "" ? { problem: "a CATEGORICAL label is not empty" } : { value: raw };
}

function show(runId: string, deps: LabelRunDeps): number {
  const record = deps.getRecord(runId);
  if (!record) {
    deps.out(`error: no run ${runId}`);
    return 1;
  }
  const out = deps.out;
  out(`run ${runId}: app ${record.app}, commit ${record.sha}, verdict ${record.verdict ?? "none yet"}`);
  const rawPlan = deps.getRunPlan(runId);
  if (rawPlan === undefined) out("\nplan: none kept");
  else {
    try {
      const plan = JSON.parse(rawPlan) as { kind: string; reason?: string; unvisited?: string[]; flows?: Array<{ id: string; objective: string; acceptance?: string[]; visits?: string[]; outcome?: { kind: string; reason?: string } }> };
      out(`\nplan: ${plan.kind}${plan.reason ? ` (${plan.reason})` : ""}${plan.unvisited?.length ? `; change pages no flow visits: ${plan.unvisited.join(", ")}` : ""}`);
      for (const flow of plan.flows ?? []) {
        out(`  flow ${flow.id} [${flow.outcome ? `${flow.outcome.kind}${flow.outcome.reason ? `: ${flow.outcome.reason}` : ""}` : "not ended"}]: ${flow.objective}`);
        for (const a of flow.acceptance ?? []) out(`    - ${a}`);
        if (flow.visits?.length) out(`    visits: ${flow.visits.join(", ")}`);
      }
    } catch {
      out("\nplan: unreadable");
    }
  }
  const specs = deps.deliveredSpecs(runId);
  out(`\ndelivered specs: ${specs.length}`);
  for (const spec of specs) {
    const cases = record.cases.filter((c) => c.file !== undefined && (spec.path === c.file || spec.path.endsWith(`/${c.file}`) || c.file.endsWith(`/${spec.path}`)));
    out(`  ${spec.path}`);
    for (const title of testTitles(spec.text)) out(`    test: ${title}${cases.some((c) => c.name.includes(title)) ? ` [${cases.find((c) => c.name.includes(title))!.status}]` : ""}`);
  }
  const reference = referenceFor(deps.references(), record.app, record.sha);
  if (!reference) out(`\nreference: no use cases for ${record.app} ${record.sha} in ${USE_CASES_DIR}`);
  else {
    out(`\nreference: ${reference.summary}${reference.base ? ` (from ${reference.base})` : ""}`);
    if (reference.useCases.length === 0) out("  no use cases: nothing to cover");
    for (const u of reference.useCases) out(`  ${u.id} [${u.reachability}]: ${u.description}${u.why ? ` (${u.why})` : ""}`);
  }
  const judged = deps.scores(runId).filter((s) => s.source === "llm_judge" || s.source === "human");
  if (judged.length > 0) {
    out("\njudged:");
    for (const s of judged) out(`  ${s.name} (${s.source}) = ${String(s.value)}${s.comment ? `: ${s.comment}` : ""}`);
  }
  return 0;
}

/** Returns the process exit code. A bad argument prints the usage and returns 2. */
export function main(argv: readonly string[], deps: LabelRunDeps): number {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    deps.out(parsed.problem);
    deps.out(USAGE);
    return 2;
  }
  if (parsed.show) return show(parsed.runId, deps);
  if (!deps.getRecord(parsed.runId)) {
    deps.out(`error: no run ${parsed.runId}`);
    return 1;
  }
  const spec = specOfScore(parsed.name) ?? judgeLabelSpec(parsed.name);
  if (!spec) {
    deps.out(`error: ${parsed.name} is neither a score of the catalog nor a judge`);
    return 2;
  }
  const typed = typedValue(spec, parsed.value);
  if ("problem" in typed) {
    deps.out(`error: ${parsed.name}: ${typed.problem}`);
    return 2;
  }
  deps.save(
    [{ runId: parsed.runId, name: parsed.name, graderVersion: "human", dataType: spec.dataType, polarity: spec.polarity, source: "human", value: typed.value, comment: parsed.comment ? deps.sanitize(parsed.comment).slice(0, MAX_SCORE_COMMENT_CHARS) : null, observationId: null }],
    deps.now(),
  );
  deps.out(`labelled ${parsed.runId} ${parsed.name} = ${String(typed.value)}`);
  return 0;
}

/* Every reference set of the directory; a file that is not one stops the command, naming it. */
export function loadReferences(dir: string = USE_CASES_DIR): UseCaseReference[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((n) => parseUseCaseReference(JSON.parse(readFileSync(join(dir, n), "utf8")) as unknown, n));
}

/** The run history of the orchestrator container, imported lazily so a test that injects its own never opens it. */
export async function defaultDeps(): Promise<LabelRunDeps> {
  const { getRecord, getRunPlan, listRunScoreRows, listSpecSnapshots, replaceRunScores } = await import("../src/server/history.ts");
  const { RedactionPortAdapter } = await import("../src/orchestrator/sanitizer.ts");
  const redaction = new RedactionPortAdapter();
  return {
    getRecord: (id) => getRecord(id),
    getRunPlan,
    deliveredSpecs: (id) => {
      const newest = new Map<string, { path: string; text: string; at: number }>();
      for (const row of listSpecSnapshots(id)) if (row.delivered === 1 && (newest.get(row.path)?.at ?? -1) <= row.capturedAt) newest.set(row.path, { path: row.path, text: row.text, at: row.capturedAt });
      return [...newest.values()].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, text }) => ({ path, text }));
    },
    scores: listRunScoreRows,
    references: () => loadReferences(),
    save: (rows, at) => replaceRunScores(rows, at),
    sanitize: (text) => redaction.redact(text),
    now: () => new Date().toISOString(),
    out: (line) => console.log(line),
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  defaultDeps()
    .then((deps) => process.exit(main(process.argv.slice(2), deps)))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
