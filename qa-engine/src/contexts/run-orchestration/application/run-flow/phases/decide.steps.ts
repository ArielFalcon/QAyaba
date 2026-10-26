/* The decide phase of a run: the final proof guard over the delivered specs, the verdict's decision and the coordinated run's closing telemetry. */

import { decide, type RunEvidence } from "../../../domain/run-decision.service.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import { runEnd } from "../run-end.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import { runOf, type DecidedOutcome, type RunState } from "../run-state.ts";
import { reviewsTests } from "./review.steps.ts";

type Result = Promise<StepOutcome<RunState>>;

/* What the decision and everything after it rests on; a step after the decide phase cannot run before it. */
export function decidedOf(state: Readonly<RunState>): DecidedOutcome {
  if (!state.decided) throw new Error("the run has not been decided yet");
  return state.decided;
}

/* The run's reviewer verdict for its outcome: the one the review step's dispatched review gave, absent when the run ended before any review ran. */
export const reviewerApprovedForOutcomeOf = (state: Readonly<RunState>): boolean | undefined => state.review.reviewerApprovedForOutcome;

/* A context run's pass is synthetic and a code-target run has no suite store: only a generated browser suite has proven bytes to guard. */
export const guardsFinalProof = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  runOf(state).verdict === "pass" && state.classification.generating && ctx.input.mode !== "context" && !ctx.cfg.isCode;

/*
 * The bytes on disk are the proof. Before the run decides, fingerprint the delivered specs once more and put back the proven
 * bytes of any file that changed after its acceptance; a file with no proof, or a restore that does not verify, ends the run
 * as a loud infra-error. No proof means no publication (fails closed).
 */
export async function guardFinalProof(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, services } = ctx;
  const { specRoot, proofBytes, snapshotPort } = services;
  const deliveredFiles = [...new Set(state.generation.delivered.map((d) => d.file))].filter((file) => file.endsWith(".spec.ts"));
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
    const proofSha256 = state.proof[file];
    if (proofSha256 !== undefined && current.get(file) === proofSha256) continue;
    if (proofSha256 === undefined) {
      return end("final-proof-guard", {
        note: `the final proof guard found no proof for ${file}: the run cannot publish bytes that never executed green`,
      });
    }
    const provenBytes = proofBytes.get(file);
    if (provenBytes === undefined) {
      return end("final-proof-guard", {
        note: `the final proof guard found ${file} changed after it executed green, but holds no proven bytes to restore`,
      });
    }
    try {
      await snapshotPort.restore(workspace.specDir, { files: new Map([[file, provenBytes]]) }, []);
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
    if (restored.get(file) !== proofSha256) {
      return end("final-proof-guard", {
        note: `the final proof guard restored ${file} but its bytes still differ from the proven ones`,
      });
    }
  }
}

/* The last step of the table: the run reached its decision, and finalizeRun carries it out (publish, prune, persist, learn). */
export async function decideRun(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, cfg, input } = ctx;
  deps.observer?.onStep("decide");
  const evidence: RunEvidence = {
    verdict: runOf(state).verdict,
    generating: state.classification.generating,
    needsReview: reviewsTests(ctx),
    reviewerApproved: state.review.reviewerApproved,
    blocksPublish: state.coverage.blocksPublish,
    shadow: cfg.shadow,
    onFailure: cfg.onFailure,
  };
  const decision = decide(evidence);
  const isContextCleanPass = input.mode === "context" && decision.verdict === "pass";
  return { end: runEnd(isContextCleanPass ? "context-pass" : "decided"), update: { decided: { evidence, decision, isContextCleanPass } } };
}
