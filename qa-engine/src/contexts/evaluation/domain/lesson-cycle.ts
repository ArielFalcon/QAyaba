/*
 * The cycle measure of the lesson slice (docs/architecture/rfc/0013-learning-slice.md, Q6-Q8): one frozen and one learning replicate of the same
 * commit and snapshot, read as a direction and never as proof. Pure: it reads the scores of the campaign's runs and nothing else.
 *
 * A cycle is a pair: the runs of the campaign that share a commit, a suite snapshot, a replicate number and every variant label but `lessons`, one of
 * them told lessons (`lessons=on`). Runs that pair with nothing make no cycle and a pair with an arm that was not measured is `unproven`.
 *
 * Over the pages the learning replicate's lessons cover, improvement is: its data-state failures are lower and its calls-to-green not higher, and no
 * guard (mutants killed, changed lines covered on the final bytes, defects found) is lower. Green never counts: no score of the verdict is read. A pair
 * counts only when a lesson was delivered and at least one replicate shows a data-state failure on those pages or a spec there that needed more than
 * one call; otherwise the trigger did not occur and the cycle repeats. The campaign's verdict is `unproven` unless every run pairs and at least one pair
 * counts; a counted pair without improvement makes it `not-improved`, the kill criterion's case.
 */

import type { CampaignRun, RunScore } from "./campaign-comparison.ts";
import { LESSON_SLICE_SCORE, decodeLessonSlice, routeCoveredBy, scopeCovers, type LessonSlice } from "./lesson-slice.ts";

/* The arm that was told lessons carries this variant label (`grounding.lessons: true`, launched with `--grounding lessons=on`). */
export const LEARNING_LABEL = { key: "lessons", value: "on" } as const;

export const CYCLE_MEASURE = "data_state_failures";
export const CYCLE_CALLS = "calls_to_green";
/* The scores that must not be lower in the learning replicate. */
export const CYCLE_GUARDS = ["mutation_kill_rate", "change_coverage_ratio", "defect_found"] as const;

export type CycleVerdict = "improved" | "not-improved" | "unproven";
export type CycleDirection = "better" | "same" | "worse" | "not-compared";
/* `not-counted`: the trigger did not occur. `invalid`: an arm was not measured, or the two cannot be compared. */
export type PairStatus = "improved" | "not-improved" | "not-counted" | "invalid";

export interface CycleMeasure {
  readonly name: string;
  readonly frozen: number | undefined;
  readonly learning: number | undefined;
  readonly direction: CycleDirection;
}

export interface CyclePair {
  readonly commit: string;
  readonly replicate: number;
  readonly frozenRun: string;
  readonly learningRun: string;
  readonly status: PairStatus;
  /* Why the status is what it is, one line each. */
  readonly reasons: readonly string[];
  readonly measures: readonly CycleMeasure[];
}

export interface LessonCycle {
  readonly verdict: CycleVerdict;
  readonly frozenRuns: number;
  readonly learningRuns: number;
  /* Why the verdict is what it is, one line each. */
  readonly reasons: readonly string[];
  readonly pairs: readonly CyclePair[];
  /* The runs that paired with nothing: they make no cycle. */
  readonly unpaired: readonly string[];
}

const isLearning = (run: CampaignRun): boolean => run.variant[LEARNING_LABEL.key] === LEARNING_LABEL.value;

function sliceOf(run: CampaignRun): LessonSlice | undefined {
  const score = run.scores.find((s) => s.name === LESSON_SLICE_SCORE && s.dataType === "CATEGORICAL");
  return score === undefined ? undefined : decodeLessonSlice(score.value);
}

function numberOf(run: CampaignRun, name: string): RunScore | undefined {
  return run.scores.find((s) => s.name === name && s.dataType === "NUMERIC" && typeof s.value === "number" && Number.isFinite(s.value));
}

const meanOf = (values: readonly number[]): number | undefined => (values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length);

function direction(frozen: number | undefined, learning: number | undefined, lowerIsBetter: boolean): CycleDirection {
  if (frozen === undefined || learning === undefined) return "not-compared";
  if (learning === frozen) return "same";
  return (learning < frozen) === lowerIsBetter ? "better" : "worse";
}

/* The variant labels the two replicates of a pair share: every one but the lesson lever. */
const sharedLabels = (run: CampaignRun): string => JSON.stringify(Object.entries(run.variant).filter(([key]) => key !== LEARNING_LABEL.key).sort(([a], [b]) => (a < b ? -1 : 1)));

interface Measured {
  readonly run: CampaignRun;
  readonly slice: LessonSlice;
}

/* The figures of one replicate over the pages the lessons cover. */
function coveredBy(scopes: readonly string[], slice: LessonSlice): { failures: number; calls: number[] } {
  const covers = (path: string): boolean => scopes.some((scope) => scopeCovers(scope, path));
  const flowCovered = (routes: readonly string[]): boolean => routes.some((route) => scopes.some((scope) => routeCoveredBy(scope, route)));
  return {
    failures: (slice.failures ?? []).filter((f) => covers(f.path)).reduce((sum, f) => sum + f.count, 0),
    calls: slice.specs.filter((spec) => flowCovered(spec.routes)).map((spec) => spec.calls),
  };
}

function judgePair(frozen: Measured, learning: Measured): CyclePair {
  const { commit } = learning.slice;
  const head = { commit, replicate: learning.run.replicate, frozenRun: frozen.run.runId, learningRun: learning.run.runId };
  const scopes = learning.slice.scopes;
  const reached = [frozen, learning].map((m) => coveredBy(scopes, m.slice));
  const [f, l] = reached as [ReturnType<typeof coveredBy>, ReturnType<typeof coveredBy>];
  const failures: CycleMeasure = { name: CYCLE_MEASURE, frozen: f.failures, learning: l.failures, direction: direction(f.failures, l.failures, true) };
  const calls: CycleMeasure = { name: CYCLE_CALLS, frozen: meanOf(f.calls), learning: meanOf(l.calls), direction: direction(meanOf(f.calls), meanOf(l.calls), true) };
  const guards = CYCLE_GUARDS.map((name): CycleMeasure => {
    const a = numberOf(frozen.run, name);
    const b = numberOf(learning.run, name);
    return { name, frozen: a?.value as number | undefined, learning: b?.value as number | undefined, direction: a && b && a.graderVersion === b.graderVersion ? direction(a.value as number, b.value as number, false) : "not-compared" };
  });
  const measures = [failures, calls, ...guards];
  const settle = (status: PairStatus, ...reasons: string[]): CyclePair => ({ ...head, status, reasons, measures });

  if (scopes.length === 0) return settle("not-counted", "no lesson was delivered in the learning replicate, so the trigger did not occur");
  if (frozen.slice.failures === null || learning.slice.failures === null) {
    const unmeasured = [frozen.slice.failures === null ? "frozen" : undefined, learning.slice.failures === null ? "learning" : undefined].filter((arm) => arm !== undefined).join(" and ");
    return settle("invalid", `the data-state failures were not measured in the ${unmeasured} replicate`);
  }
  if (f.failures === 0 && l.failures === 0 && !f.calls.concat(l.calls).some((n) => n > 1)) {
    return settle("not-counted", "neither replicate shows a data-state failure on the pages the lessons cover or a spec there that needed more than one run_spec call, so the trigger did not occur");
  }
  if ((f.calls.length === 0) !== (l.calls.length === 0)) {
    return settle("invalid", `a spec on the pages the lessons cover went green in the ${f.calls.length === 0 ? "learning" : "frozen"} replicate only, so calls-to-green cannot be compared`);
  }
  const missing = guards.filter((g) => g.direction === "not-compared" && (g.frozen !== undefined || g.learning !== undefined));
  if (missing.length > 0) {
    const why = (g: CycleMeasure): string => (g.frozen !== undefined && g.learning !== undefined ? `${g.name} was graded by different grader versions in the two replicates` : `${g.name} is scored in the ${g.frozen === undefined ? "learning" : "frozen"} replicate only`);
    return settle("invalid", ...missing.map((g) => `${why(g)}, so whether a guard is lower cannot be told`));
  }

  const reasons: string[] = [];
  if (failures.direction !== "better") reasons.push(`data-state failures on the covered pages are not lower in the learning replicate (${l.failures} against ${f.failures})`);
  if (calls.direction === "worse") reasons.push(`calls-to-green are higher in the learning replicate (${calls.learning} against ${calls.frozen})`);
  for (const guard of guards) if (guard.direction === "worse") reasons.push(`${guard.name} is lower in the learning replicate (${guard.learning} against ${guard.frozen})`);
  if (reasons.length > 0) return settle("not-improved", ...reasons);
  return settle("improved", `data-state failures on the covered pages are lower in the learning replicate (${l.failures} against ${f.failures}), calls-to-green are not higher and no measured guard is lower`);
}

export function judgeLessonCycle(runs: readonly CampaignRun[]): LessonCycle {
  const frozenRuns = runs.filter((run) => !isLearning(run)).length;
  const learningRuns = runs.length - frozenRuns;
  const groups = new Map<string, { frozen: Measured[]; learning: Measured[] }>();
  const unpaired: string[] = [];
  const reasons: string[] = [];
  for (const run of runs) {
    const slice = sliceOf(run);
    if (slice === undefined) {
      unpaired.push(run.runId);
      continue;
    }
    const key = JSON.stringify([slice.commit, run.snapshot ?? null, run.replicate, sharedLabels(run)]);
    const group = groups.get(key) ?? { frozen: [], learning: [] };
    (isLearning(run) ? group.learning : group.frozen).push({ run, slice });
    groups.set(key, group);
  }
  const pairs: CyclePair[] = [];
  for (const { frozen, learning } of groups.values()) {
    if (frozen.length === 1 && learning.length === 1) pairs.push(judgePair(frozen[0]!, learning[0]!));
    else unpaired.push(...[...frozen, ...learning].map((m) => m.run.runId));
  }
  const base = { frozenRuns, learningRuns, pairs, unpaired };
  const unproven = (...why: string[]): LessonCycle => ({ verdict: "unproven", reasons: why, ...base });

  if (pairs.length === 0) return unproven(`a cycle needs one frozen and one learning replicate of the same commit and snapshot; the campaign has ${frozenRuns} frozen and ${learningRuns} learning run(s), none of which pair${unpaired.length > 0 ? ` (${unpaired.join(", ")} carry no lesson slice or find no single counterpart)` : ""}`);
  if (unpaired.length > 0) reasons.push(`${unpaired.length} run(s) pair with nothing (no lesson slice, no counterpart of the same commit, snapshot and replicate, or more than one): ${unpaired.join(", ")}`);
  for (const pair of pairs) if (pair.status === "invalid") reasons.push(...pair.reasons.map((reason) => `${pair.commit} replicate ${pair.replicate}: ${reason}`));
  if (reasons.length > 0) return unproven(...reasons);
  const counted = pairs.filter((pair) => pair.status === "improved" || pair.status === "not-improved");
  if (counted.length === 0) return unproven(...pairs.flatMap((pair) => pair.reasons.map((reason) => `${pair.commit} replicate ${pair.replicate}: ${reason}`)));
  const failed = counted.filter((pair) => pair.status === "not-improved");
  if (failed.length > 0) return { verdict: "not-improved", reasons: failed.flatMap((pair) => pair.reasons.map((reason) => `${pair.commit} replicate ${pair.replicate}: ${reason}`)), ...base };
  return { verdict: "improved", reasons: counted.flatMap((pair) => pair.reasons.map((reason) => `${pair.commit} replicate ${pair.replicate}: ${reason}`)), ...base };
}

const fmt = (n: number | undefined): string => (n === undefined ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(3));

const VERDICT_TEXT: Record<CycleVerdict, string> = {
  improved: "improved (a direction, not proof)",
  "not-improved": "not improved: a counted cycle without improvement; the kind's code is deleted and its observations stay",
  unproven: "unproven: the cycle does not count and repeats",
};

export function renderLessonCycleMarkdown(cycle: LessonCycle): string {
  return [
    "## Lesson cycle",
    "",
    `${cycle.frozenRuns} frozen and ${cycle.learningRuns} learning run(s), ${cycle.pairs.length} pair(s). Verdict: **${VERDICT_TEXT[cycle.verdict]}**.`,
    "",
    ...cycle.reasons.map((reason) => `- ${reason}`),
    ...cycle.pairs.flatMap((pair) => [
      "",
      `### ${pair.commit}, replicate ${pair.replicate}: ${pair.status}`,
      "",
      "| Measure | Frozen | Learning | Learning arm |",
      "|---|---|---|---|",
      ...pair.measures.map((m) => `| ${m.name} | ${fmt(m.frozen)} | ${fmt(m.learning)} | ${m.direction} |`),
    ]),
    "",
  ].join("\n");
}
