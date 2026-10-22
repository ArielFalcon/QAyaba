/*
 * Calibration of an LLM judge against human labels (docs/observability-design.md section 11.3). Pure and deterministic.
 *
 * A judge is only trusted for what it measured: the pairs (human label, judge score) of the same run and score name are split by a
 * hash of the run id into train, dev and test. Train and dev are what a prompt author reads and tunes against; ONLY the test split
 * decides the status, because a judge tuned on a pair is not evidence about that pair.
 *
 *  - BINARY judge: the positive class is `pass` (true). TPR = P(judge pass | human pass), TNR = P(judge fail | human fail).
 *  - CATEGORICAL judge: one-vs-rest per class, over the classes the humans used on the test split; TPR and TNR are the macro averages
 *    over those classes. Every class the humans used needs the minimum number of labels, and at least two classes must be used.
 *
 * `calibrated` needs TPR >= minTpr, TNR >= minTnr and at least `minN` test labels in each class. Everything else is `experimental`,
 * which is the default state of every judge. The status is information for a consumer: nothing in the pipeline reads it to decide.
 */

import { createHash } from "node:crypto";
import type { JudgeDefinition, JudgeStatus } from "./judges.ts";
import type { ScoreValue } from "./score.ts";

export type CalibrationSplit = "train" | "dev" | "test";

/* Out of ten buckets of the id hash: four for train, three for dev, three for test. */
const SPLIT_BUCKETS: readonly CalibrationSplit[] = ["train", "train", "train", "train", "dev", "dev", "dev", "test", "test", "test"];

export function splitOfRun(runId: string): CalibrationSplit {
  const digest = createHash("sha256").update(runId).digest();
  return SPLIT_BUCKETS[digest.readUInt32BE(0) % SPLIT_BUCKETS.length]!;
}

export interface CalibrationThresholds {
  minTpr: number;
  minTnr: number;
  /* The fewest test labels each class needs. */
  minN: number;
}

export const DEFAULT_CALIBRATION: CalibrationThresholds = { minTpr: 0.8, minTnr: 0.8, minN: 20 };

/* A human label and a judge score of the same run and name. */
export interface LabeledPair {
  runId: string;
  human: ScoreValue;
  judge: ScoreValue;
}

export interface ClassRates {
  class: string;
  /* Human labels of this class on the test split. */
  n: number;
  tpr: number | null;
  tnr: number | null;
}

export interface CalibrationReport {
  judge: string;
  promptVersion: string;
  model: string;
  splits: Record<CalibrationSplit, { n: number }>;
  /* The test split only. Null while it cannot be computed (no labels, or a class with none). */
  tpr: number | null;
  tnr: number | null;
  agreement: number | null;
  /* Human labels per class on the test split: pass/fail for a binary judge, each used category for a categorical one. */
  classCounts: Record<string, number>;
  /* Categorical judges only. */
  perClass?: ClassRates[];
  thresholds: CalibrationThresholds;
  status: JudgeStatus;
  /* Why a judge is not calibrated; empty when it is. */
  reasons: string[];
  computedAt: string;
}

export interface CalibrationContext {
  promptVersion: string;
  model: string;
  computedAt: string;
  thresholds?: CalibrationThresholds;
}

const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/* The pairs whose values both fit the judge's type (and, for a categorical judge, whose human class is in the closed set). */
function fits(def: JudgeDefinition, pair: LabeledPair): boolean {
  if (def.dataType === "BOOLEAN") return typeof pair.human === "boolean" && typeof pair.judge === "boolean";
  return typeof pair.human === "string" && typeof pair.judge === "string" && (def.categories?.includes(pair.human) ?? false);
}

export function calibrate(def: JudgeDefinition, pairs: readonly LabeledPair[], ctx: CalibrationContext): CalibrationReport {
  const thresholds = ctx.thresholds ?? DEFAULT_CALIBRATION;
  const usable = pairs.filter((p) => fits(def, p));
  const bySplit: Record<CalibrationSplit, LabeledPair[]> = { train: [], dev: [], test: [] };
  for (const pair of usable) bySplit[splitOfRun(pair.runId)].push(pair);
  const test = bySplit.test;
  const splits = { train: { n: bySplit.train.length }, dev: { n: bySplit.dev.length }, test: { n: test.length } };
  const agreement = rate(test.filter((p) => p.human === p.judge).length, test.length);
  const reasons: string[] = [];
  let tpr: number | null = null;
  let tnr: number | null = null;
  let classCounts: Record<string, number> = {};
  let perClass: ClassRates[] | undefined;

  if (def.dataType === "BOOLEAN") {
    const positives = test.filter((p) => p.human === true);
    const negatives = test.filter((p) => p.human === false);
    classCounts = { pass: positives.length, fail: negatives.length };
    tpr = rate(positives.filter((p) => p.judge === true).length, positives.length);
    tnr = rate(negatives.filter((p) => p.judge === false).length, negatives.length);
    for (const [label, count] of Object.entries(classCounts)) {
      if (count < thresholds.minN) reasons.push(`class ${label} has ${count} test labels, needs ${thresholds.minN}`);
    }
  } else {
    const used = [...new Set(test.map((p) => p.human as string))].sort();
    perClass = used.map((cls) => {
      const support = test.filter((p) => p.human === cls);
      const rest = test.filter((p) => p.human !== cls);
      return { class: cls, n: support.length, tpr: rate(support.filter((p) => p.judge === cls).length, support.length), tnr: rate(rest.filter((p) => p.judge !== cls).length, rest.length) };
    });
    classCounts = Object.fromEntries(perClass.map((c) => [c.class, c.n]));
    tpr = mean(perClass.flatMap((c) => (c.tpr === null ? [] : [c.tpr])));
    tnr = mean(perClass.flatMap((c) => (c.tnr === null ? [] : [c.tnr])));
    if (perClass.length < 2) reasons.push(`only ${perClass.length} class used by the humans on the test split, needs at least 2`);
    for (const c of perClass) if (c.n < thresholds.minN) reasons.push(`class ${c.class} has ${c.n} test labels, needs ${thresholds.minN}`);
  }

  if (test.length === 0) reasons.push("no test labels");
  else if (tpr === null || tnr === null) reasons.push("a rate cannot be computed on the test split");
  else {
    if (tpr < thresholds.minTpr) reasons.push(`TPR ${tpr.toFixed(3)} is below ${thresholds.minTpr}`);
    if (tnr < thresholds.minTnr) reasons.push(`TNR ${tnr.toFixed(3)} is below ${thresholds.minTnr}`);
  }

  return {
    judge: def.name,
    promptVersion: ctx.promptVersion,
    model: ctx.model,
    splits,
    tpr,
    tnr,
    agreement,
    classCounts,
    ...(perClass ? { perClass } : {}),
    thresholds,
    status: reasons.length === 0 ? "calibrated" : "experimental",
    reasons,
    computedAt: ctx.computedAt,
  };
}
