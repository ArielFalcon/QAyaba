/*
 * What the review rounds need besides the loop itself: reading the specs a round judges, the evidence a rebuttal may rest on, the
 * running tally of what the phase cost, and the telemetry a round's decision leaves. They are functions of the round's inputs, so the
 * loop in review.steps.ts stays the one place that decides.
 */

import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewStats } from "../../ports/index.ts";
import { diffContracts } from "@contexts/objective-signal/domain/test-intent-contract.ts";
import { readConfinedSpecFile, type SpecRoot } from "../../../../../shared-infrastructure/spec-path-confinement.ts";
import type { ReviewSpecText } from "@contexts/generation/domain/review-fingerprint.ts";
import { refKey, type RebuttalEvidence, type ReviewRebuttal } from "../../../domain/review-rebuttals.service.ts";
import type { WorkspaceRunContext } from "../run-context.ts";

/*
 * The specs a round judges, read through the confined reader: a name that leaves the directory, or a file that is gone,
 * contributes nothing and the round fails open to the model.
 */
export function readReviewedSpecs(specRoot: SpecRoot, cases: readonly QaCase[]): ReviewSpecText[] {
  const seen = new Set<string>();
  const specs: ReviewSpecText[] = [];
  for (const c of cases) {
    const file = c.file ?? c.name;
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      specs.push({ file, text: readConfinedSpecFile(specRoot, file) });
    } catch {
      /* Unreadable spec: no pre-check and no duplicate round for it; the model reviewer still sees it from the prompt. */
    }
  }
  return specs;
}

/*
 * What the current bytes prove, the only facts a rebuttal can rest on: the cases that ran green (a case name,
 * or a spec file whose every case passed), and the contract clauses the bytes still hold. A basis the run
 * cannot check stays unverified, so the finding it answers keeps standing.
 */
export function rebuttalEvidence(ctx: WorkspaceRunContext, cases: readonly QaCase[], rebuttals: readonly ReviewRebuttal[]): RebuttalEvidence {
  const specRoot: SpecRoot = { mirrorDir: ctx.workspace.mirrorDir, specDir: ctx.workspace.specDir };
  const { intentState } = ctx.services;
  const failedFiles = new Set(cases.filter((c) => c.status !== "pass" && c.file).map((c) => c.file!));
  const greenCaseRefs = new Set<string>();
  for (const c of cases) {
    if (c.status !== "pass") continue;
    greenCaseRefs.add(refKey(c.name));
    if (c.file && !failedFiles.has(c.file)) greenCaseRefs.add(refKey(c.file));
  }
  const intactClauses = new Set<string>();
  const extractor = ctx.deps.intentContract;
  if (extractor) {
    for (const rebuttal of rebuttals) {
      if (rebuttal.basis !== "contract") continue;
      const key = refKey(rebuttal.ref);
      const hash = key.lastIndexOf("#");
      const file = hash > 0 ? key.slice(0, hash) : "";
      const clause = hash > 0 ? key.slice(hash + 1) : "";
      if (!file || !clause) continue;
      try {
        const extraction = extractor.extract(file, readConfinedSpecFile(specRoot, file));
        const baseline = intentState.baselines.get(file) ?? [];
        const violated = diffContracts(baseline, extraction.specs, intentState.tokens).some((delta) => delta.clauseId === clause);
        if (!violated && extraction.specs.some((spec) => spec.clauses.some((c) => c.id === clause))) intactClauses.add(key);
      } catch {
        /* An unreadable spec or clause proves nothing: the rebuttal stays unverified. */
      }
    }
  }
  return { greenCaseRefs, intactClauses };
}

/* What the review phase cost, rolled up over its rounds. */
export interface ReviewTally {
  rounds: number;
  modelRounds: number;
  preCheckRejects: number;
  skippedRounds: number;
  durationMs: number;
  promptBytes: number;
  outputTokens: number;
  costUsd: number;
  steps: number;
  blocking: number;
  rebuttals: number;
  rebuttalWithdrawn: number;
  metricsKnown: { output: boolean; cost: boolean; steps: boolean };
}

export function newReviewTally(): ReviewTally {
  return {
    rounds: 0,
    modelRounds: 0,
    preCheckRejects: 0,
    skippedRounds: 0,
    durationMs: 0,
    promptBytes: 0,
    outputTokens: 0,
    costUsd: 0,
    steps: 0,
    blocking: 0,
    rebuttals: 0,
    rebuttalWithdrawn: 0,
    metricsKnown: { output: false, cost: false, steps: false },
  };
}

export function addReviewStats(tally: ReviewTally, stats: ReviewStats | undefined): void {
  if (!stats) return;
  tally.durationMs += stats.durationMs;
  tally.promptBytes += stats.promptBytes;
  if (stats.outputTokens !== undefined) {
    tally.outputTokens += stats.outputTokens;
    tally.metricsKnown.output = true;
  }
  if (stats.costUsd !== undefined) {
    tally.costUsd += stats.costUsd;
    tally.metricsKnown.cost = true;
  }
  if (stats.steps !== undefined) {
    tally.steps += stats.steps;
    tally.metricsKnown.steps = true;
  }
}

/* The review phase span carries what the review came to, so a false-positive rejection is queryable. Only set once a round has judged. */
export function annotateReviewPhase(ctx: WorkspaceRunContext, tally: ReviewTally, correctionClass: string | undefined, outcome: string): void {
  try {
    ctx.trail.spans.annotate({
      "qayaba.phase.outcome": outcome,
      "qayaba.review.rounds": tally.rounds,
      "qayaba.review.model_rounds": tally.modelRounds,
      "qayaba.review.blocking": tally.blocking,
      "qayaba.review.correction_class": correctionClass ?? "none",
    });
  } catch (err) {
    console.error(`[qa] the review phase outcome could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* What one round decided, as the evidence an agent reading the trace needs. */
export interface ReviewDecisionRecord {
  round: number;
  outcome: string;
  decidedBy: string;
  correctionClass: string;
  blocking: number;
  targets: string[];
  existingSpecFiles: readonly string[];
  corrections: readonly string[];
  filtered: number;
  advisory: number;
  rationale: string | undefined;
  durationMs: number | undefined;
}

/*
 * The decision evidence, not just its aggregate: an agent reading the trace must see which
 * specs the reviewer judged, which of them already existed, the bounded corrections and the
 * class the failure falls into. The metric carries the closed class; the span carries the
 * high-cardinality paths and text.
 */
export function recordReviewDecision(ctx: WorkspaceRunContext, record: ReviewDecisionRecord): void {
  const { telemetry, input } = ctx;
  try {
    const reviewSpan = telemetry.startSpan("qayaba.review.decision", {
      attrs: {
        "qayaba.app": input.app,
        "qayaba.review.round": record.round,
        "qayaba.review.outcome": record.outcome,
        "qayaba.review.decided_by": record.decidedBy,
        "qayaba.review.correction_class": record.correctionClass,
        "qayaba.review.blocking": record.blocking,
        "qayaba.review.targets": record.targets,
        ...(record.existingSpecFiles.length ? { "qayaba.review.existing_specs": [...record.existingSpecFiles] } : {}),
        ...(record.corrections.length ? { "qayaba.review.corrections": [...record.corrections] } : {}),
        /* What the filter set aside: a dropped finding can never block, an advisory one is recorded only. */
        ...(record.filtered > 0 ? { "qayaba.review.filtered": record.filtered } : {}),
        ...(record.advisory > 0 ? { "qayaba.review.advisory": record.advisory } : {}),
        ...(record.rationale ? { "qayaba.review.rationale": record.rationale } : {}),
      },
    });
    reviewSpan.end();
  } catch (err) {
    console.error(`[telemetry] the reviewer decision span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
  telemetry.counter("qayaba.review")(1, {
    "qayaba.app": input.app,
    "qayaba.review.outcome": record.outcome,
    "qayaba.review.decided_by": record.decidedBy,
    "qayaba.review.correction_class": record.correctionClass,
  });
  if (record.durationMs !== undefined) {
    telemetry.histogram("qayaba.review.duration")(record.durationMs / 1000, {
      "qayaba.app": input.app,
      "qayaba.review.outcome": record.outcome,
    });
  }
}
