/*
 * The cycle measure of the lesson slice (docs/architecture/rfc/0013-learning-slice.md, Q6-Q8): one frozen and one learning replicate of the same
 * commit and snapshot, read as a direction and never as proof. Pure: it reads the scores of the campaign's runs and nothing else.
 *
 * Improvement: the learning arm's data-state failures are lower and its calls-to-green not higher, and no guard (mutants killed, changed lines
 * covered on the final bytes, defects found) is lower. Green never counts: no score of the verdict is read. A cycle counts only when a lesson was
 * delivered and at least one run shows a data-state failure or a spec that needed more than one call; otherwise, or when the measure could not be
 * taken in both arms, it is `unproven` and the cycle repeats.
 */

import type { CampaignRun } from "./campaign-comparison.ts";

/* The arm that was told lessons carries this variant label (`grounding.lessons: true`, launched with `--grounding lessons=on`). */
export const LEARNING_LABEL = { key: "lessons", value: "on" } as const;

export const CYCLE_MEASURE = "data_state_failures";
export const CYCLE_CALLS = "calls_to_green";
export const CYCLE_DELIVERED = "lessons_delivered";
/* The scores that must not be lower in the learning arm. */
export const CYCLE_GUARDS = ["mutation_kill_rate", "change_coverage_ratio", "defect_found"] as const;

export type CycleVerdict = "improved" | "not-improved" | "unproven";
export type CycleDirection = "better" | "same" | "worse" | "not-compared";

export interface CycleMeasure {
  readonly name: string;
  /* Mean over the arm's runs that carry the score; undefined when none does. */
  readonly frozen: number | undefined;
  readonly learning: number | undefined;
  readonly direction: CycleDirection;
}

export interface LessonCycle {
  readonly verdict: CycleVerdict;
  readonly frozenRuns: number;
  readonly learningRuns: number;
  /* Why the verdict is what it is, one line each. */
  readonly reasons: readonly string[];
  readonly measures: readonly CycleMeasure[];
}

const isLearning = (run: CampaignRun): boolean => run.variant[LEARNING_LABEL.key] === LEARNING_LABEL.value;

function numbers(runs: readonly CampaignRun[], name: string): number[] {
  return runs.flatMap((run) => run.scores.flatMap((s) => (s.name === name && s.dataType === "NUMERIC" && typeof s.value === "number" && Number.isFinite(s.value) ? [s.value] : [])));
}

const meanOf = (values: readonly number[]): number | undefined => (values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length);

function direction(frozen: number | undefined, learning: number | undefined, lowerIsBetter: boolean): CycleDirection {
  if (frozen === undefined || learning === undefined) return "not-compared";
  if (learning === frozen) return "same";
  return (learning < frozen) === lowerIsBetter ? "better" : "worse";
}

export function judgeLessonCycle(runs: readonly CampaignRun[]): LessonCycle {
  const learningRuns = runs.filter(isLearning);
  const frozenRuns = runs.filter((run) => !isLearning(run));
  const measure = (name: string, lowerIsBetter: boolean): CycleMeasure => {
    const frozen = meanOf(numbers(frozenRuns, name));
    const learning = meanOf(numbers(learningRuns, name));
    return { name, frozen, learning, direction: direction(frozen, learning, lowerIsBetter) };
  };
  const failures = measure(CYCLE_MEASURE, true);
  const calls = measure(CYCLE_CALLS, true);
  const guards = CYCLE_GUARDS.map((name) => measure(name, false));
  const measures = [failures, calls, ...guards];
  const base = { frozenRuns: frozenRuns.length, learningRuns: learningRuns.length, measures };
  const unproven = (...reasons: string[]): LessonCycle => ({ verdict: "unproven", reasons, ...base });

  if (learningRuns.length === 0 || frozenRuns.length === 0) return unproven(`a cycle needs one frozen and one learning replicate of the same commit; the campaign has ${frozenRuns.length} frozen and ${learningRuns.length} learning run(s)`);
  if (!numbers(learningRuns, CYCLE_DELIVERED).some((n) => n > 0)) return unproven("no lesson was delivered in the learning arm, so the trigger did not occur");
  const triggered = numbers(runs, CYCLE_MEASURE).some((n) => n > 0) || numbers(runs, CYCLE_CALLS).some((n) => n > 1);
  if (!triggered) return unproven("neither arm shows a data-state failure or a spec that needed more than one run_spec call, so the trigger did not occur");
  if (failures.direction === "not-compared") return unproven("the data-state failures were not measured in both arms");

  const reasons: string[] = [];
  if (failures.direction !== "better") reasons.push(`data-state failures are not lower in the learning arm (${failures.learning} against ${failures.frozen})`);
  if (calls.direction === "worse") reasons.push(`calls-to-green are higher in the learning arm (${calls.learning} against ${calls.frozen})`);
  for (const guard of guards) if (guard.direction === "worse") reasons.push(`${guard.name} is lower in the learning arm (${guard.learning} against ${guard.frozen})`);
  if (reasons.length > 0) return { verdict: "not-improved", reasons, ...base };
  return { verdict: "improved", reasons: [`data-state failures are lower in the learning arm (${failures.learning} against ${failures.frozen}), calls-to-green are not higher and no guard is lower`], ...base };
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
    `${cycle.frozenRuns} frozen and ${cycle.learningRuns} learning run(s). Verdict: **${VERDICT_TEXT[cycle.verdict]}**.`,
    "",
    ...cycle.reasons.map((reason) => `- ${reason}`),
    "",
    "| Measure | Frozen | Learning | Learning arm |",
    "|---|---|---|---|",
    ...cycle.measures.map((m) => `| ${m.name} | ${fmt(m.frozen)} | ${fmt(m.learning)} | ${m.direction} |`),
    "",
  ].join("\n");
}
