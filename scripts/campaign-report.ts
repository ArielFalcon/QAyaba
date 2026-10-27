/*
 * What a campaign writes: the record (JSON), its markdown table and the rubric the owner scores. EXPERIMENT ONLY, pure.
 * A figure that was not measured is null and reads `n/a`; it is never a zero and stays out of every median.
 */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { Arm, CaseKind, CaseExpectation, Outcome, SpecAssessment } from "./campaign-model.ts";

export interface ArmRunResult {
  caseId: string;
  arm: Arm;
  /** 1-based. */
  replicate: number;
  /** 1-based place of the arm in this replicate's order. */
  position: number;
  /** The label the arm's own report carries. */
  label: string;
  /** The pipeline's run id; null for the plain agent. */
  runId: string | null;
  verdict: RunVerdict | null;
  errorClass: string | null;
  note: string | null;
  outcome: Outcome;
  matchesExpected: boolean;
  /** The spec files the arm delivered (the pipeline's only when its run was accepted). */
  delivered: string[];
  /** Where the arm's files are kept, relative to the campaign directory; null when there were none. */
  savedTo: string | null;
  specs: SpecAssessment[];
  /** One entry per re-run of the delivered set. */
  validationRuns: Array<{ verdict: RunVerdict; error?: string }>;
  /** Delivered, not flagged, green on both re-runs. */
  valid: boolean;
  /** `pending` while the owner has not scored a valid candidate; `n/a` when there is nothing to score. */
  rubric: "pending" | "n/a";
  costUsd: number | null;
  wallMs: number | null;
  /** The wall time without the change-coverage phase (where the value oracle runs), when the arm reports it. */
  wallExclOracleMs: number | null;
  steps: number | null;
  start: "warm" | "cold";
  /** The delivered files include a new auth.setup.ts: the arm wrote its own login despite the warm start. */
  loginRewritten: boolean;
  capped: boolean;
  invalidReplicate: boolean;
  invalidReasons: string[];
  /**
   * The digest of the suite the pipeline run restored from the suite store (the `qayaba.suite_store.restored_digest` of its restore span).
   * Absent for an arm that has no suite store or a record written before the digest existed; null when the run's spans could not be read.
   */
  restoredDigest?: string | null;
}

export interface CampaignCaseRecord {
  id: string;
  kind: CaseKind;
  sha: string;
  expected: CaseExpectation;
}

export interface CampaignEnvironment {
  /** QA_CAMPAIGN_FREEZE as this process saw it. */
  campaignFreeze: boolean;
  appShadow: boolean;
  /** The pipeline arm was asked for shadow in its run request. */
  forcedShadow: boolean;
}

export interface CampaignRecord {
  schema: 1;
  label: string;
  app: string;
  startedAt: string;
  finishedAt: string | null;
  /** False when the campaign stopped before its last arm-run. */
  complete: boolean;
  args: { replicas: number; arms: Arm[]; wallCapMin: number; warm: string; casesPath: string; closedLoop?: boolean; agentBrowser?: boolean };
  environment: CampaignEnvironment;
  snapshot: { label: string; createdAt: string; warm: boolean };
  cases: CampaignCaseRecord[];
  results: ArmRunResult[];
}

/* ── isolation between replicates ──────────────────────────────────────────────────── */

const caseArmKey = (r: ArmRunResult): string => `${r.caseId}\u0000${r.arm}`;
/** Only a pipeline run restores from a suite store, so only it has an isolation to know or not to know. */
const hasSuiteStore = (r: ArmRunResult): boolean => r.runId !== null;

/**
 * Every replicate of a case and arm starts from the same suite: the warm snapshot, seeded before the run. A replicate whose restore put
 * back another set than the first replicate's started from something else (a run still going when the store was seeded, a spec an
 * earlier replicate left behind), so it is not a draw of the same experiment. It is marked invalid with the reason and the statistics
 * leave it out. A replicate with no digest, or one whose reference has none, cannot be judged: it stays as it was and the report says
 * its isolation is unknown.
 */
export function withIsolation(results: readonly ArmRunResult[]): ArmRunResult[] {
  const reasons = isolationReasons(results, caseArmKey, (r) => r.replicate, (r) => r.restoredDigest);
  return results.map((r, i) => (reasons[i] === null ? r : { ...r, invalidReplicate: true, invalidReasons: [...r.invalidReasons, reasons[i]!] }));
}

/**
 * The one comparison both campaign reports use: per item, the reason it started from another suite than the first replicate of its group
 * (`group` names the case and arm, or the variant), or null when it did not or cannot be judged (no digest of its own or of the reference).
 */
export function isolationReasons<T>(items: readonly T[], group: (item: T) => string, replicate: (item: T) => number, digest: (item: T) => string | null | undefined): Array<string | null> {
  const reference = new Map<string, T>();
  for (const item of items) {
    const known = reference.get(group(item));
    if (known === undefined || replicate(item) < replicate(known)) reference.set(group(item), item);
  }
  return items.map((item) => {
    const first = reference.get(group(item))!;
    const own = digest(item);
    const firstDigest = digest(first);
    if (first === item || typeof own !== "string" || typeof firstDigest !== "string" || own === firstDigest) return null;
    return `the restored suite differs from replicate ${replicate(first)}'s (digest ${own.slice(0, 12)} against ${firstDigest.slice(0, 12)}): the suite store was not reset between them`;
  });
}

/* ── summary ───────────────────────────────────────────────────────────────────────── */

export interface CellSummary {
  caseId: string;
  arm: Arm;
  replicates: number;
  /** Replicates that could be compared (not flagged invalid). */
  usable: number;
  /** Usable replicates whose delivered set is valid. */
  valid: number;
  /** Usable replicates whose outcome is what the case expects. */
  matchedExpected: number;
  medianCostUsd: number | null;
  medianWallMs: number | null;
  medianSteps: number | null;
}

function median(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 === 1 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2;
}

export function summarize(results: readonly ArmRunResult[]): CellSummary[] {
  const cells = new Map<string, ArmRunResult[]>();
  for (const r of withIsolation(results)) {
    const key = caseArmKey(r);
    cells.set(key, [...(cells.get(key) ?? []), r]);
  }
  return [...cells.values()].map((runs) => {
    const usable = runs.filter((r) => !r.invalidReplicate);
    return {
      caseId: runs[0]!.caseId,
      arm: runs[0]!.arm,
      replicates: runs.length,
      usable: usable.length,
      valid: usable.filter((r) => r.valid).length,
      matchedExpected: usable.filter((r) => r.matchesExpected).length,
      medianCostUsd: median(usable.map((r) => r.costUsd)),
      medianWallMs: median(usable.map((r) => r.wallMs)),
      medianSteps: median(usable.map((r) => r.steps)),
    };
  });
}

/* ── markdown ──────────────────────────────────────────────────────────────────────── */

const NA = "n/a";
const usd = (v: number | null): string => (v === null ? NA : `$${v.toFixed(4)}`);
const mins = (ms: number | null): string => (ms === null ? NA : `${(ms / 60_000).toFixed(1)} min`);
const num = (v: number | null): string => (v === null ? NA : String(v));
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const yesNo = (v: boolean): string => (v ? "yes" : "no");

function flagsOf(r: ArmRunResult): string {
  const kinds = [...new Set(r.specs.flatMap((s) => s.flags.map((f) => f.kind)))];
  return kinds.length === 0 ? "" : kinds.join(", ");
}

const RUN_COLUMNS = ["case", "arm", "rep", "order", "verdict", "expected outcome", "valid", "valid / delivered", "flags", "rubric", "USD", "wall", "wall w/o oracle", "steps", "start", "replicate"] as const;
const SUMMARY_COLUMNS = ["case", "arm", "replicates", "comparable", "valid", "as expected", "median USD", "median wall", "median steps"] as const;
const header = (columns: readonly string[]): string => `| ${columns.join(" | ")} |\n|${columns.map(() => "---").join("|")}|`;

export function renderMarkdown(record: CampaignRecord): string {
  const lines: string[] = [];
  lines.push(`# Campaign ${record.label}`, "");
  lines.push(`App \`${record.app}\`; warm snapshot \`${record.snapshot.label}\` (taken ${record.snapshot.createdAt}, ${record.snapshot.warm ? "warm" : "COLD"}); ${record.args.replicas} replicate(s); arms ${record.args.arms.join(", ")}; wall cap ${record.args.wallCapMin} min per arm-run.`);
  lines.push(`Started ${record.startedAt}${record.finishedAt ? `, finished ${record.finishedAt}` : ""}.`);
  if (!record.complete) lines.push("", "**This campaign did not finish: it stopped before its last arm-run. Read the rows below as partial.**");
  lines.push("", "## Conditions", "");
  const e = record.environment;
  lines.push(`- learning frozen (\`QA_CAMPAIGN_FREEZE\`): ${yesNo(e.campaignFreeze)}`);
  lines.push(`- warm start: the snapshot is seeded into the suite store before each arm-run (the pipeline restores it after its checkout; the plain agent applies it to its throwaway copy)`);
  lines.push(`- app in shadow mode: ${yesNo(e.appShadow)}; pipeline arm asked for shadow in its request: ${yesNo(e.forcedShadow)}`);

  lines.push("", "## Per arm-run", "", header(RUN_COLUMNS));
  for (const r of withIsolation(record.results)) {
    const replicate = r.invalidReplicate ? `INVALID: ${r.invalidReasons.join("; ")}` : typeof r.restoredDigest === "string" || !hasSuiteStore(r) ? "ok" : "ok (isolation unknown)";
    lines.push(`| ${[
      r.caseId, r.arm, String(r.replicate), String(r.position), r.verdict ?? NA, `${r.outcome} (${r.matchesExpected ? "as expected" : "not as expected"})`,
      yesNo(r.valid), `${r.specs.filter((s) => s.valid).length} / ${r.delivered.length}`, flagsOf(r) || "-", r.rubric, usd(r.costUsd), mins(r.wallMs), mins(r.wallExclOracleMs), num(r.steps),
      r.start + (r.loginRewritten ? " (login rewritten)" : ""), replicate,
    ].map(cell).join(" | ")} |`);
  }

  lines.push("", "## Per case and arm", "", header(SUMMARY_COLUMNS));
  for (const s of summarize(record.results)) {
    lines.push(`| ${[s.caseId, s.arm, String(s.replicates), String(s.usable), `${s.valid} / ${s.usable}`, `${s.matchedExpected} / ${s.usable}`, usd(s.medianCostUsd), mins(s.medianWallMs), num(s.medianSteps)].map(cell).join(" | ")} |`);
  }
  lines.push("", "Medians are over comparable replicates and over the figures that were measured; `n/a` means no replicate measured it. `valid` means: delivered, not flagged as a fake pass, and green on both re-runs without retry. The rubric (`rubric.csv`) lists the valid candidates for the owner to score 0-3.", "");
  return lines.join("\n");
}

/* ── rubric ────────────────────────────────────────────────────────────────────────── */

const csvField = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return /[",]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
};

export const RUBRIC_HEADER = ["case", "arm", "replicate", "specs", "must_verify", "files", "score_0_3", "notes"] as const;

/** One row per valid, comparable arm-run, for the owner to score 0-3 against what the case says a valid spec must verify. */
export function renderRubricCsv(record: CampaignRecord): string {
  const mustVerify = new Map(record.cases.map((c) => [c.id, c.expected.mustVerify]));
  const rows = withIsolation(record.results)
    .filter((r) => r.valid && !r.invalidReplicate)
    .map((r) => [r.caseId, r.arm, String(r.replicate), r.delivered.join(" "), mustVerify.get(r.caseId) ?? "", r.savedTo ?? "", "", ""].map(csvField).join(","));
  return `${[RUBRIC_HEADER.join(","), ...rows].join("\n")}\n`;
}
