/* The publish phase of a run: the write-confinement pass, the durable captures that must precede publication, the pull request or Issue the decision calls for, and the mirror's pruning. */

import { isAccepted } from "../../../domain/run-decision.service.ts";
import { rethrowIfUntrusted } from "../../../../../shared-kernel/domain-error.ts";
import type { PublicationPort } from "../../ports/index.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { decidedOf } from "./decide.steps.ts";
import { resolveTested } from "./fix-loop.steps.ts";

type Result = Promise<StepOutcome<RunState>>;

/*
 * Every side-effect-bearing decision calls publish — not just "pr". "none" is
 * the only skip. Thread this run's reviewerApproved and blocksPublish so a
 * green-but-rejected run opens an Issue and an enforce coverage fail holds the PR.
 * e2eChanged is omitted (no computed source — do not fabricate).
 * Cross-repo Issues file in triggerRepo; PRs still target the primary.
 */
export async function enforceConfinement(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  await ctx.services.confinement.enforce();
}

/*
 * A clean context-mode pass neither persists nor folds: it produced an architecture map, not
 * tests. A context run whose map failed validation already ended through terminalResult,
 * without persisting or folding either.
 *
 * A clean context-mode pass wrote the FE<->BE architecture map to the mirror's
 * e2e/.qa/context.json. That file does not survive the mirror's next `git checkout -f` +
 * `git clean -fd`, so the orchestrator captures it into the durable store BEFORE publication —
 * in both shadow and non-shadow runs, whatever publish() then does with a context.json PR
 * (including throwing). Off-path: a capture fault is logged and never changes the verdict.
 */
export async function captureContextMap(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace } = ctx;
  if (!decidedOf(state).isContextCleanPass || !deps.contextMapCapture) return;
  try {
    await deps.contextMapCapture.capture(workspace.specDir, input.app, input.sha.toString());
  } catch (captureErr) {
    console.warn(
      `[qa] context-map capture failed (off-path; verdict unchanged): ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`,
    );
  }
}

/*
 * An accepted run proved its suite, whatever happens to the pull request (and in shadow mode none is opened): the suite is kept
 * before publication, so the next run's checkout cannot wipe it. Off-path: a fault is logged and never changes the verdict.
 */
export const keepsSuite = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  !!ctx.deps.suiteStore && state.setup.suiteRestored && isAccepted(decidedOf(state).evidence);

export async function keepAcceptedSuite(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace, services, ends } = ctx;
  const { authVerifiedSha256 } = state.execution;
  try {
    const kept = await deps.suiteStore!.capture({
      mirrorDir: workspace.mirrorDir,
      specDir: workspace.specDir,
      runId: input.runId,
      sha: input.sha.toString(),
      /* The ledger's own hashes: every file admitted is one whose green bytes this run holds. */
      executedGreen: new Map([...services.proofLedger].map(([file, proof]) => [file, proof.sha256])),
      ...(authVerifiedSha256 !== undefined ? { authVerifiedSha256 } : {}),
    });
    ends.announceSuite(`[qa] suite store: kept ${kept.entries} file(s) (${kept.admitted} new or changed, ${kept.dropped} dropped${kept.skipped.length > 0 ? `, ${kept.skipped.length} left out` : ""})`, "info");
  } catch (captureErr) {
    rethrowIfUntrusted(captureErr);
    ends.announceSuite(`[qa] suite store capture failed (off-path; verdict unchanged): ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`, "warn");
  }
}

export const publishes = (state: Readonly<RunState>): boolean => decidedOf(state).decision.sideEffect !== "none";

export async function publishDecision(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg, workspace, services } = ctx;
  const { run } = state.execution;
  const { reviewerApproved } = state.review;
  const { lastAdjudicatorVerdict } = state.fixLoop;
  /*
   * Publication can throw after a verdict is already decided. Catch here, keep
   * the decided record, and surface the hop failure as a diagnostic. Non-Error
   * throws still escape.
   */
  let published: Awaited<ReturnType<PublicationPort["publish"]>>;
  try {
    published = await deps.publication.publish({
      verdict: run.verdict,
      cases: run.cases,
      logs: run.logs,
      reviewerApproved,
      coverageBlocks: state.coverage.blocksPublish,
      ...(input.triggerRepo ? { issueRepo: input.triggerRepo } : {}),
      /* Adjudication is absent when FixLoop never engaged — never fabricated. */
      ...(lastAdjudicatorVerdict ? { adjudication: lastAdjudicatorVerdict } : {}),
      /* Real per-run mirrorDir + sha for the "pr" git-write. This is the only pr-capable call site. */
      mirrorDir: workspace.mirrorDir,
      sha: input.sha.toString(),
      /*
       * tested omitted when empty. parentRunId only from /continue — never fabricated.
       * Intra-run regens reuse this same input object.
       */
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      isCode: cfg.isCode,
      ...(resolveTested(state)?.length ? { tested: resolveTested(state) } : {}),
    });
  } catch (pubErr) {
    return end("publication-failed", {
      note: `publication failed after verdict was decided (decided: ${run.verdict}, reviewerApproved: ${reviewerApproved}): ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`,
    });
  }
  /*
   * Merge denylist reverts into gateSignals.confinement. Count only
   * revertedDangerous toward dangerous — not every revert is a secret leak.
   * Absent revertedDangerous is treated as zero, never "everything is dangerous".
   */
  if (published.revertedDenylisted?.length) {
    services.confinement.add({
      strays: published.revertedDenylisted.length,
      dangerous: published.revertedDangerous?.length ?? 0,
      reverted: [...published.revertedDenylisted],
    });
  }
  return { update: { publication: { publishOutcome: published.outcome } } };
}

/* Once, after confinement and publish, so gc never races this run's git write. */
export async function pruneAfterPublish(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  await ctx.ends.pruneMirror(ctx.workspace.mirrorDir);
}
