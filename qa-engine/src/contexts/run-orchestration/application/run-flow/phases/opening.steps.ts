/* The opening of a run: the deploy gate, then (in the prepared working copy) the change's classification, the run deadline and the code index. */

import { isOk } from "@kernel/result.ts";
import { ACTION_SEVERITY } from "@contexts/change-analysis/application/index.ts";
import { changeTokens } from "@contexts/objective-signal/application/index.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "../run-context.ts";
import type { CompanionClassification, RunState } from "../run-state.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CodeGraphIndexRecord } from "@kernel/code/index.ts";

type Result = Promise<StepOutcome<RunState>>;

export async function waitForDeploy(_state: Readonly<RunState>, ctx: RunContext): Result {
  ctx.deps.observer?.onStep("gate");
  const failure = await awaitEntryDeploys(ctx);
  /* Thread the deploy-gate InfraError message as the diagnostic note — never drop it. */
  if (failure !== undefined) return end("deploy-gate-failed", { note: failure });
}

/*
 * Waits for DEV to serve each entry of the run's change at its head, in entry order, and stops at the first that does not.
 * The anchor waits on the run's gate, every other entry on its own repo's gate; an entry with no gate is not awaited. The
 * message of a run over several repos names the repo that failed. Returns that message, or undefined when all serve.
 */
export async function awaitEntryDeploys(ctx: RunContext): Promise<string | undefined> {
  const { entries, anchor } = ctx.input.changeSet;
  for (const entry of entries) {
    const gate = entry === anchor ? ctx.deps.deployGate : ctx.deps.companionDeployGates?.get(entry.repo);
    if (!gate) continue;
    const result = await gate.waitUntilServing(entry === anchor ? ctx.input.sha : entry.headSha);
    if (!isOk(result)) return entries.length > 1 ? `${entry.repo}: ${result.error.message}` : result.error.message;
  }
  return undefined;
}

/*
 * Only "diff" mode classifies; the others always generate.
 * Classify-skip is a bare return (save no, fold no). Agent-no-op skip later
 * persists (save yes, fold no) even though both verdicts are "skipped".
 * "regression" runs the existing suite without generating.
 */
export async function classifyChange(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  ctx.deps.observer?.onStep("classify");
  const { entries, anchor } = ctx.input.changeSet;
  const classification = await ctx.deps.changeAnalysis.classify(anchor);
  /* The other entries are read on their own; the run's action is the most test-worthy of them all, so one repo's docs-only push never hides another's logic change. */
  const companions: CompanionClassification[] = [];
  for (const entry of entries) {
    if (entry === anchor) continue;
    const c = await ctx.deps.changeAnalysis.classify(entry);
    companions.push({ repo: entry.repo, diff: c.diff, ...(c.intent ? { intent: c.intent } : {}), action: c.action, reason: c.reason });
  }
  let action = classification.action;
  let reason = classification.reason;
  for (const c of companions) {
    if (ACTION_SEVERITY[c.action] > ACTION_SEVERITY[action]) {
      action = c.action;
      reason = `${c.repo}: ${c.reason}`;
    }
  }
  if (action === "skip") {
    /* Prepare already checked out the mirror. Classify-skip does not persist, but the working copy was touched and is pruned with the end. */
    return end("classify-skipped");
  }
  return {
    update: {
      classification: {
        diff: classification.diff,
        intent: classification.intent,
        reason,
        contradiction: classification.contradiction,
        generating: action !== "regression",
        ...(companions.length > 0 ? { companions } : {}),
      },
    },
  };
}

/* Armed here because a diff run's budget follows the size of its change, known only now; a classify-skip has already returned without spending any agent time. */
export async function armRunDeadline(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { diff, intent } = state.classification;
  ctx.services.intentState.tokens = changeTokens(diff ?? "");
  ctx.deps.runDeadline?.arm({ mode: ctx.input.mode, ...(diff !== undefined ? { diff } : {}), ...(intent ? { changedFiles: intent.changedFiles } : {}) });
  ctx.host.noteDeadlineArmed();
}

/*
 * Indexes every repo the run's graph signals read (the classify-source repo at the run's SHA and, on a service-triggered
 * run, the primary repo at the commit it is checked out at), each on its own: a failure of one never stops the other, and
 * none stops the run. Each index leaves its provenance as a span. Classify-skip already returned (that path may GC the
 * mirror). No onStep("index").
 */
export async function indexMirror(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace } = ctx;
  if (deps.codeGraph) {
    const sourceDir = deps.codeGraphRepoDir ?? ctx.services.specRoot.mirrorDir;
    await indexOne(ctx, deps.codeGraph, sourceDir, input.sha.toString());
    const primary = deps.codeGraphPrimary;
    if (primary && primary.repoDir !== sourceDir) {
      try {
        const head = await primary.headSha();
        if (head) await indexOne(ctx, deps.codeGraph, primary.repoDir, head);
        else console.warn("[qa] the primary repo's commit could not be read; it is not indexed this run");
      } catch (err) {
        console.warn("[qa] the primary repo's commit could not be read; it is not indexed this run:", err);
      }
    }
    /* Every other service entry of the change is indexed at its own head. */
    for (const entry of input.changeSet.entries) {
      const dir = deps.codeGraphRepoDirs?.get(entry.repo);
      if (dir && dir !== sourceDir && entry !== input.changeSet.anchor) await indexOne(ctx, deps.codeGraph, dir, entry.headSha.toString());
    }
  }
}

async function indexOne(ctx: WorkspaceRunContext, codeGraph: CodeGraphPort, repoDir: string, sha: string): Promise<void> {
  let record: CodeGraphIndexRecord;
  try {
    record = await codeGraph.syncTo(repoDir, sha, ctx.signal);
  } catch (err) {
    console.warn("[qa] code-graph indexing failed (non-blocking):", err);
    return;
  }
  if (record.outcome === "failed" || record.outcome === "timeout") console.warn(`[qa] code-graph indexing of ${record.repo} ${record.outcome} (non-blocking): ${record.reason ?? "no reason given"}`);
  recordIndex(ctx, record);
}

function recordIndex(ctx: WorkspaceRunContext, record: CodeGraphIndexRecord): void {
  const { telemetry, input } = ctx;
  try {
    telemetry.startSpan("qayaba.code_graph.index", {
      attrs: {
        "qayaba.app": input.app,
        "qayaba.code_graph.repo": record.repo,
        "qayaba.code_graph.engine": record.engine,
        "qayaba.code_graph.sha": record.sha,
        "qayaba.code_graph.outcome": record.outcome,
        "qayaba.code_graph.duration_ms": record.durationMs,
        ...(record.engineVersion !== null ? { "qayaba.code_graph.engine_version": record.engineVersion } : {}),
        ...(record.nodeCount !== null ? { "qayaba.code_graph.node_count": record.nodeCount } : {}),
        ...(record.edgeCount !== null ? { "qayaba.code_graph.edge_count": record.edgeCount } : {}),
        ...(record.reason !== undefined ? { "qayaba.code_graph.reason": record.reason } : {}),
      },
    }).end();
  } catch (err) {
    console.error(`[telemetry] the code-graph index span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
  telemetry.counter("qayaba.code_graph.index")(1, { "qayaba.code_graph.outcome": record.outcome });
}
