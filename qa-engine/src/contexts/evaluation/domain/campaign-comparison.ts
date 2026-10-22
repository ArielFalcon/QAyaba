/*
 * The comparison of a campaign's arms (docs/observability-design.md section 12): per variant and per score the mean with a bootstrap 95%
 * confidence interval, and the difference against a baseline arm with its own interval. Pure and deterministic: the resampling uses a
 * seeded generator, so the same runs and seed give the same report.
 *
 * Rules the report keeps:
 * - A difference is called a lift (or a regression) only when the interval of the difference excludes zero in the score's better (worse)
 *   direction AND both arms have at least MIN_REPLICATES replicates. A single run proves nothing about an arm.
 * - A score is compared only across runs graded by the same grader version (the newest one seen); other runs are counted as excluded.
 * - Numbers are NUMERIC scores and BOOLEAN scores (true = 1, pass-oriented). CATEGORICAL scores have no mean and are listed as not aggregated.
 * - The unit is a run (an item x replicate): the API does not tell which item a run replayed, so there is no paired analysis here.
 */

export const MIN_REPLICATES = 3;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;
export const DEFAULT_SEED = 20261018;
export const CONFIDENCE = 0.95;

export type Polarity = "higher_better" | "lower_better" | "none";
export type DataType = "NUMERIC" | "BOOLEAN" | "CATEGORICAL";

export interface RunScore {
  readonly name: string;
  readonly value: number | boolean | string;
  readonly dataType: DataType;
  readonly polarity: Polarity;
  readonly graderVersion: string;
}

export interface CampaignRun {
  readonly runId: string;
  readonly variant: Readonly<Record<string, string>>;
  readonly replicate: number;
  readonly scores: readonly RunScore[];
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

export interface ArmStat {
  /* Runs that carry this score, after the grader-version rule. */
  readonly n: number;
  /* Distinct replicate numbers among those runs. */
  readonly replicates: number;
  readonly mean: number;
  /* Null when there is one value: an interval of one point says nothing. */
  readonly ci: Interval | null;
}

export type Assessment = "lift" | "regression" | "shift" | "no-detectable-difference" | "insufficient-replicates";

export interface Difference {
  /* Treatment minus baseline. */
  readonly delta: number;
  readonly ci: Interval | null;
  readonly assessment: Assessment;
}

export interface ScoreComparison {
  readonly name: string;
  readonly polarity: Polarity;
  readonly dataType: DataType;
  readonly graderVersion: string;
  /* Runs left out because another grader version scored them. */
  readonly excluded: number;
  readonly arms: Readonly<Record<string, ArmStat>>;
  /* By arm key; absent without a baseline, and for the baseline itself. */
  readonly versusBaseline: Readonly<Record<string, Difference>>;
}

export interface ArmSummary {
  readonly key: string;
  readonly variant: Readonly<Record<string, string>>;
  readonly runs: number;
  readonly replicates: number;
}

export interface CampaignComparison {
  readonly campaignId: string;
  readonly seed: number;
  readonly iterations: number;
  readonly minReplicates: number;
  readonly baseline: string | null;
  readonly arms: readonly ArmSummary[];
  readonly scores: readonly ScoreComparison[];
  /* Score names with no mean (categorical). */
  readonly notAggregated: readonly string[];
}

export class ComparisonError extends Error {}

/* The label of an arm: its variant labels in key order. */
export function armKey(variant: Readonly<Record<string, string>>): string {
  const entries = Object.entries(variant).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? "(no variant)" : entries.map(([k, v]) => `${k}=${v}`).join(",");
}

/* mulberry32: a tiny seeded generator, enough for resampling and identical everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A stable 32-bit hash of the parts, so each (score, arm) resamples from its own stream and adding a score never moves another's interval. */
function seedFor(seed: number, ...parts: string[]): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) h = Math.imul(h ^ part.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ 0xff, 16777619) >>> 0;
  }
  return h;
}

export function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function resampledMean(values: readonly number[], random: () => number): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[random() * values.length | 0]!;
  return sum / values.length;
}

function percentileInterval(sorted: readonly number[]): Interval {
  const alpha = (1 - CONFIDENCE) / 2;
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))]!;
  return { low: at(alpha), high: at(1 - alpha) };
}

/* Percentile bootstrap interval of the mean. Null for fewer than two values. */
export function bootstrapMeanCi(values: readonly number[], random: () => number, iterations: number): Interval | null {
  if (values.length < 2) return null;
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) means.push(resampledMean(values, random));
  return percentileInterval(means.sort((a, b) => a - b));
}

/* Percentile bootstrap interval of mean(treatment) - mean(baseline), each arm resampled on its own. Null when either arm has fewer than two values. */
export function bootstrapDiffCi(treatment: readonly number[], baseline: readonly number[], random: () => number, iterations: number): Interval | null {
  if (treatment.length < 2 || baseline.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 0; i < iterations; i++) deltas.push(resampledMean(treatment, random) - resampledMean(baseline, random));
  return percentileInterval(deltas.sort((a, b) => a - b));
}

function numeric(score: RunScore): number | undefined {
  if (score.dataType === "BOOLEAN") return score.value === true ? 1 : score.value === false ? 0 : undefined;
  if (score.dataType === "NUMERIC") return typeof score.value === "number" && Number.isFinite(score.value) ? score.value : undefined;
  return undefined;
}

function newerVersion(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na > nb : a.localeCompare(b, undefined, { numeric: true }) > 0;
}

/* Enough to call a difference: at least MIN_REPLICATES values AND at least MIN_REPLICATES distinct replicate numbers. */
const enough = (stat: ArmStat): boolean => stat.n >= MIN_REPLICATES && stat.replicates >= MIN_REPLICATES;

function assess(delta: number, ci: Interval | null, polarity: Polarity, treatment: ArmStat, baseline: ArmStat): Assessment {
  if (ci === null) return "insufficient-replicates";
  const excludesZero = ci.low > 0 || ci.high < 0;
  if (!enough(treatment) || !enough(baseline)) return "insufficient-replicates";
  if (!excludesZero) return "no-detectable-difference";
  if (polarity === "none") return "shift";
  const better = polarity === "higher_better" ? delta > 0 : delta < 0;
  return better ? "lift" : "regression";
}

export interface CompareOptions {
  readonly campaignId: string;
  /* Labels the baseline arm carries (all of them). Absent: no differences. */
  readonly baseline?: Readonly<Record<string, string>>;
  readonly seed?: number;
  readonly iterations?: number;
}

function matches(variant: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>): boolean {
  return Object.entries(labels).every(([k, v]) => Object.hasOwn(variant, k) && variant[k] === v);
}

export function compareCampaign(runs: readonly CampaignRun[], options: CompareOptions): CampaignComparison {
  const seed = options.seed ?? DEFAULT_SEED;
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const byArm = new Map<string, { variant: Readonly<Record<string, string>>; runs: CampaignRun[] }>();
  for (const run of runs) {
    const key = armKey(run.variant);
    const arm = byArm.get(key) ?? { variant: run.variant, runs: [] };
    arm.runs.push(run);
    byArm.set(key, arm);
  }
  const armKeys = [...byArm.keys()].sort();

  let baselineKey: string | null = null;
  if (options.baseline && Object.keys(options.baseline).length > 0) {
    const found = armKeys.filter((k) => matches(byArm.get(k)!.variant, options.baseline!));
    if (found.length === 0) throw new ComparisonError(`no arm carries the baseline labels ${armKey(options.baseline)}; the arms are: ${armKeys.join("; ") || "none"}`);
    if (found.length > 1) throw new ComparisonError(`the baseline labels ${armKey(options.baseline)} match ${found.length} arms (${found.join("; ")}); name enough labels to pick one`);
    baselineKey = found[0]!;
  }

  /* The newest grader version seen per score name, and the scores that cannot be averaged. */
  const versionOf = new Map<string, string>();
  const meta = new Map<string, { polarity: Polarity; dataType: DataType }>();
  const notAggregated = new Set<string>();
  for (const run of runs) {
    for (const s of run.scores) {
      if (s.dataType === "CATEGORICAL") {
        notAggregated.add(s.name);
        continue;
      }
      const cur = versionOf.get(s.name);
      if (cur === undefined || newerVersion(s.graderVersion, cur)) versionOf.set(s.name, s.graderVersion);
      meta.set(s.name, { polarity: s.polarity, dataType: s.dataType });
    }
  }

  const scores: ScoreComparison[] = [];
  for (const name of [...versionOf.keys()].sort()) {
    const graderVersion = versionOf.get(name)!;
    const { polarity, dataType } = meta.get(name)!;
    let excluded = 0;
    const values = new Map<string, { vals: number[]; replicates: Set<number> }>();
    for (const key of armKeys) {
      const entry = { vals: [] as number[], replicates: new Set<number>() };
      for (const run of byArm.get(key)!.runs) {
        const score = run.scores.find((s) => s.name === name);
        if (!score) continue;
        if (score.graderVersion !== graderVersion) {
          excluded += 1;
          continue;
        }
        const v = numeric(score);
        if (v === undefined) continue;
        entry.vals.push(v);
        entry.replicates.add(run.replicate);
      }
      values.set(key, entry);
    }
    const arms: Record<string, ArmStat> = {};
    for (const key of armKeys) {
      const { vals, replicates } = values.get(key)!;
      if (vals.length === 0) continue;
      arms[key] = { n: vals.length, replicates: replicates.size, mean: mean(vals), ci: bootstrapMeanCi(vals, seededRandom(seedFor(seed, name, key)), iterations) };
    }
    const versusBaseline: Record<string, Difference> = {};
    if (baselineKey !== null && arms[baselineKey]) {
      for (const key of armKeys) {
        if (key === baselineKey || !arms[key]) continue;
        const delta = arms[key]!.mean - arms[baselineKey]!.mean;
        const ci = bootstrapDiffCi(values.get(key)!.vals, values.get(baselineKey)!.vals, seededRandom(seedFor(seed, name, key, baselineKey)), iterations);
        versusBaseline[key] = { delta, ci, assessment: assess(delta, ci, polarity, arms[key]!, arms[baselineKey]!) };
      }
    }
    scores.push({ name, polarity, dataType, graderVersion, excluded, arms, versusBaseline });
  }

  return {
    campaignId: options.campaignId,
    seed,
    iterations,
    minReplicates: MIN_REPLICATES,
    baseline: baselineKey,
    arms: armKeys.map((key) => {
      const arm = byArm.get(key)!;
      return { key, variant: arm.variant, runs: arm.runs.length, replicates: new Set(arm.runs.map((r) => r.replicate)).size };
    }),
    scores,
    notAggregated: [...notAggregated].sort(),
  };
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3));
const fmtCi = (ci: Interval | null): string => (ci ? `[${fmt(ci.low)}, ${fmt(ci.high)}]` : "n/a");

const ASSESSMENT_TEXT: Record<Assessment, string> = {
  lift: "lift",
  regression: "regression",
  shift: "shift (no better or worse direction)",
  "no-detectable-difference": "no detectable difference",
  "insufficient-replicates": `not a lift: fewer than ${MIN_REPLICATES} replicates, or too few values`,
};

export interface RenderOptions {
  /* The service said every run of the campaign is done and graded. */
  readonly complete?: boolean;
}

export function renderComparisonMarkdown(c: CampaignComparison, options: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# Campaign ${c.campaignId}`, "");
  lines.push(`Mean with a bootstrap 95% confidence interval per score (${c.iterations} resamples, seed ${c.seed}). The unit is a run; n counts runs, replicates counts distinct replicate numbers. A difference is a lift only when its interval excludes zero in the better direction and both arms have at least ${c.minReplicates} replicates.`, "");
  if (options.complete === false) lines.push("> The campaign is not complete: some runs are not done or not graded yet. The figures below cover the graded runs only.", "");
  lines.push("> The replicate count is a proxy: the API does not say which item a run replayed, so there is no paired per-item analysis, and a replicate number says nothing about whether two runs replayed the same item. Read a lift as a signal about the arm, not as an item-by-item comparison.", "");
  lines.push("> Known confound: engram (the agents' memory) is not isolated between replicates, so a replicate can learn from the one before it.", "");
  lines.push("## Arms", "", "| Arm | Runs | Replicates |", "|---|---|---|");
  for (const arm of c.arms) lines.push(`| ${arm.key}${arm.key === c.baseline ? " (baseline)" : ""} | ${arm.runs} | ${arm.replicates} |`);
  lines.push("");
  for (const s of c.scores) {
    lines.push(`## ${s.name}`, "", `${s.dataType.toLowerCase()}, ${s.polarity.replace("_", " ")}, grader version ${s.graderVersion}${s.excluded > 0 ? `; ${s.excluded} run(s) scored by another version were left out` : ""}`, "");
    const head = c.baseline ? "| Arm | n | Replicates | Mean | 95% CI | Difference vs baseline | 95% CI | Assessment |" : "| Arm | n | Replicates | Mean | 95% CI |";
    lines.push(head, c.baseline ? "|---|---|---|---|---|---|---|---|" : "|---|---|---|---|---|");
    for (const arm of c.arms) {
      const stat = s.arms[arm.key];
      if (!stat) continue;
      const base = `| ${arm.key} | ${stat.n} | ${stat.replicates} | ${fmt(stat.mean)} | ${fmtCi(stat.ci)}`;
      if (!c.baseline) {
        lines.push(`${base} |`);
        continue;
      }
      const diff = s.versusBaseline[arm.key];
      lines.push(diff ? `${base} | ${diff.delta >= 0 ? "+" : ""}${fmt(diff.delta)} | ${fmtCi(diff.ci)} | ${ASSESSMENT_TEXT[diff.assessment]} |` : `${base} | - | - | ${arm.key === c.baseline ? "baseline" : "-"} |`);
    }
    lines.push("");
  }
  if (c.notAggregated.length > 0) lines.push("## Not aggregated", "", `Categorical scores have no mean: ${c.notAggregated.join(", ")}. Read them per run.`, "");
  return lines.join("\n");
}
