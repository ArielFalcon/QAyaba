/* The decide phase of a run: the final proof guard over the delivered specs, the verdict's decision and the coordinated run's closing telemetry. */

import { decide, type RunEvidence } from "../../../domain/run-decision.service.ts";
import { reviewerApprovalOf } from "../../ports/index.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { DecidedOutcome, RunState } from "../run-state.ts";
import { reviewsTests } from "./review.steps.ts";

type Result = Promise<StepOutcome<RunState>>;

/* What the decision and everything after it rests on; a step after the decide phase cannot run before it. */
export function decidedOf(state: Readonly<RunState>): DecidedOutcome {
  if (!state.decided) throw new Error("the run has not been decided yet");
  return state.decided;
}

/* The run's final reviewer verdict for its outcome: a genuine review call's, else the generation's own flag, so fail/flaky/invalid paths still have a value. */
export const reviewerApprovedForOutcomeOf = (state: Readonly<RunState>): boolean | undefined =>
  state.review.reviewerApprovedForOutcome ?? reviewerApprovalOf(state.execution.lastGenerated);

/* A context run's pass is synthetic and a code-target run has no suite store: only a generated browser suite has proven bytes to guard. */
export const guardsFinalProof = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  state.execution.run.verdict === "pass" && state.classification.generating && ctx.input.mode !== "context" && !ctx.cfg.isCode;

/*
 * The bytes on disk are the proof. Before the run decides, fingerprint the delivered specs once more and put back the proven
 * bytes of any file that changed after its acceptance; a file with no proof, or a restore that does not verify, ends the run
 * as a loud infra-error. No proof means no publication (fails closed).
 */
export async function guardFinalProof(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, services, generation } = ctx;
  const { specRoot, proofLedger, snapshotPort } = services;
  const deliveredFiles = [...new Set(generation.delivered.map((d) => d.file))].filter((file) => file.endsWith(".spec.ts"));
  if (deliveredFiles.length === 0) return;
  let current: ReadonlyMap<string, string> = new Map();
  if (deps.suiteStore) {
    try {
      current = await deps.suiteStore.fingerprint(specRoot, deliveredFiles);
    } catch (err) {
      return end("final-proof-guard", {
        note: `the final proof guard could not fingerprint the delivered specs: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  for (const file of deliveredFiles) {
    const proof = proofLedger.get(file);
    if (proof && current.get(file) === proof.sha256) continue;
    if (!proof) {
      return end("final-proof-guard", {
        note: `the final proof guard found no proof for ${file}: the run cannot publish bytes that never executed green`,
      });
    }
    if (proof.bytes === undefined) {
      return end("final-proof-guard", {
        note: `the final proof guard found ${file} changed after it executed green, but holds no proven bytes to restore`,
      });
    }
    try {
      await snapshotPort.restore(workspace.specDir, { files: new Map([[file, proof.bytes]]) }, []);
    } catch (err) {
      return end("final-proof-guard", {
        note: `the final proof guard could not restore ${file}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!deps.suiteStore) {
      return end("final-proof-guard", {
        note: `the final proof guard cannot verify the restored ${file}: no suite store is composed`,
      });
    }
    let restored: ReadonlyMap<string, string>;
    try {
      restored = await deps.suiteStore.fingerprint(specRoot, [file]);
    } catch (err) {
      return end("final-proof-guard", {
        note: `the final proof guard could not verify the restored ${file}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (restored.get(file) !== proof.sha256) {
      return end("final-proof-guard", {
        note: `the final proof guard restored ${file} but its bytes still differ from the proven ones`,
      });
    }
  }
}

/* Publish never emits its own step; "decide" covers the decide+publish pair. */
export async function decideRun(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, cfg, input } = ctx;
  deps.observer?.onStep("decide");
  const evidence: RunEvidence = {
    verdict: state.execution.run.verdict,
    generating: state.classification.generating,
    needsReview: reviewsTests(ctx),
    reviewerApproved: state.review.reviewerApproved,
    blocksPublish: state.coverage.blocksPublish,
    shadow: cfg.shadow,
    onFailure: cfg.onFailure,
  };
  const decision = decide(evidence);
  return { update: { decided: { evidence, decision, isContextCleanPass: input.mode === "context" && decision.verdict === "pass" } } };
}

/* A coordinated run says how it ended: the verdict with the quality sampled at the same instant, and how many flows were handed back. */
export async function recordCoordinationOutcome(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, ends, startedAt } = ctx;
  const { decision } = decidedOf(state);
  const coordinationSignal = ends.coordination();
  if (!coordinationSignal || !deps.coordinationTelemetry) return;
  const { coverageRatio, valueScore } = state.coverage;
  const reviewerApprovedForOutcome = reviewerApprovedForOutcomeOf(state);
  /* Read from the same honest source as the persisted outcome: absent when no reviewer looked at this run. */
  const reviewOutcome =
    !reviewsTests(ctx) ? "skipped" as const
    : reviewerApprovedForOutcome === true ? "approved" as const
    : reviewerApprovedForOutcome === false ? "rejected" as const
    : "n/a" as const;
  deps.coordinationTelemetry.record({
    runId: input.runId,
    app: input.app,
    kind: "outcome",
    action: coordinationSignal.plan === "fanout" ? "delegate" : "direct",
    reason: `pipeline verdict=${decision.verdict}; flows ${coordinationSignal.delivered}/${coordinationSignal.flows} delivered${coordinationSignal.takeover ? "; the lead took over" : ""}`,
    finalOutcome: decision.verdict,
    reviewOutcome,
    /* Quality sampled at the same instant the outcome is stamped. */
    ...(coverageRatio !== undefined ? { coverageRatio } : {}),
    ...(valueScore !== null ? { valueScore } : {}),
    escalations: coordinationSignal.incomplete + (coordinationSignal.takeover ? 1 : 0),
    durationMs: Date.now() - startedAt,
    at: Date.now(),
  });
}
