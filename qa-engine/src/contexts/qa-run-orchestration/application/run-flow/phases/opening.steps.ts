/* The opening of a run: the deploy gate, then (in the prepared working copy) the change's classification, the run deadline and the code index. */

import { isOk } from "@kernel/result.ts";
import { changeTokens } from "@contexts/objective-signal/domain/change-tokens.ts";
import type { RunQaResult } from "../../run-qa.use-case.ts";
import type { StepResult } from "../run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";

type Result = Promise<StepResult<RunState, RunQaResult>>;

/* Already-aborted signal short-circuits before the entry gate. */
export async function stopIfAbortedBeforeGate(_state: Readonly<RunState>, ctx: RunContext): Result {
  if (ctx.signal?.aborted) return { end: await ctx.ends.aborted() };
}

export async function waitForDeploy(_state: Readonly<RunState>, ctx: RunContext): Result {
  ctx.deps.observer?.onStep("gate");
  if (ctx.deps.deployGate) {
    const gateResult = await ctx.deps.deployGate.waitUntilServing(ctx.input.sha);
    if (!isOk(gateResult)) {
      /* Thread the deploy-gate InfraError message as the diagnostic note — never drop it. */
      return { end: await ctx.ends.infraError(gateResult.error.message) };
    }
  }
  if (ctx.signal?.aborted) return { end: await ctx.ends.aborted() };
}

/*
 * Only "diff" mode classifies; the others always generate.
 * Classify-skip is a bare return (save no, fold no). Agent-no-op skip later
 * persists (save yes, fold no) even though both verdicts are "skipped".
 * "regression" runs the existing suite without generating.
 */
export async function classifyChange(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  ctx.deps.observer?.onStep("classify");
  const classification = await ctx.deps.changeAnalysis.classify(ctx.input.sha, ctx.input.baseSha ? { baseSha: ctx.input.baseSha } : undefined);
  if (classification.action === "skip") {
    /*
     * Prepare already checked out the mirror. Classify-skip does not persist, but
     * the working copy was touched and must still be pruned.
     */
    await ctx.ends.pruneMirror(ctx.workspace.mirrorDir);
    return { end: ctx.ends.skipped() };
  }
  return {
    update: {
      classification: {
        diff: classification.diff,
        intent: classification.intent,
        reason: classification.reason,
        contradiction: classification.contradiction,
        generating: classification.action !== "regression",
      },
    },
  };
}

/* Armed here because a diff run's budget follows the size of its change, known only now; a classify-skip has already returned without spending any agent time. */
export async function armRunDeadline(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { diff, intent } = state.classification;
  ctx.services.intentState.tokens = changeTokens(diff ?? "");
  ctx.deps.runDeadline?.arm({ mode: ctx.input.mode, ...(diff !== undefined ? { diff } : {}), ...(intent ? { changedFiles: intent.changedFiles } : {}) });
  ctx.ends.noteDeadlineArmed();
}

/*
 * Requires both ports. Classify-skip already returned (that path may GC the
 * mirror). SHA skip does not call syncTo. IndexFailed does not setLastIndexedSha.
 * Throws are fail-open. No onStep("index").
 */
export async function indexMirror(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace } = ctx;
  if (deps.indexStatus && deps.codeGraph) {
    try {
      const indexDir = deps.codeGraphRepoDir ?? workspace.mirrorDir;
      const lastIndexedSha = await deps.indexStatus.getLastIndexedSha(indexDir);
      if (lastIndexedSha !== input.sha.toString()) {
        const changedFiles = state.classification.intent?.changedFiles ?? [];
        const result = await deps.codeGraph.syncTo(indexDir, changedFiles);
        if (result.ok) {
          await deps.indexStatus.setLastIndexedSha(indexDir, input.sha.toString());
        } else {
          console.warn("[qa] mirror indexing failed (non-blocking):", result.error.reason);
        }
      }
    } catch (err) {
      console.warn("[qa] mirror indexing failed (non-blocking):", err);
    }
  }
  if (ctx.signal?.aborted) return { end: await ctx.ends.aborted(workspace.mirrorDir) };
}
