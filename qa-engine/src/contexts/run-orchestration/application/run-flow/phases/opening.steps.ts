/* The opening of a run: the deploy gate, then (in the prepared working copy) the change's classification, the run deadline and the code index. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { isOk } from "@kernel/result.ts";
import { DeployNotServedError, type ServedVersionFact, type ServedVersionSignal } from "@kernel/served-version.ts";
import { ACTION_SEVERITY } from "@contexts/change-analysis/application/index.ts";
import { changeTokens } from "@contexts/objective-signal/application/index.ts";
import { runTimeBudgetKey } from "../../../domain/run-time-budget.ts";
import { recordRunFact } from "../reducers.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "../run-context.ts";
import type { CompanionClassification, RunState } from "../run-state.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CodeGraphIndexRecord } from "@kernel/code/index.ts";

type Result = Promise<StepOutcome<RunState>>;

export async function waitForDeploy(state: Readonly<RunState>, ctx: RunContext): Result {
  ctx.deps.observer?.onStep("gate");
  const { failure, facts } = await verifyEntryDeploys(ctx);
  const signal = servedVersionSignalOf(ctx, facts);
  if (signal !== undefined) recordRunFact(state, "servedVersion", signal);
  annotateServedVersion(ctx, facts);
  /* Thread the deploy-gate InfraError message as the diagnostic note — never drop it. */
  if (failure !== undefined) return end("deploy-gate-failed", { note: failure });
}

/* What the gate read of each entry it reached, in the order it reached them; an entry with no gate declares no source. */
type EntryFact = ServedVersionFact & { repo: string };

/*
 * Reads what DEV serves for each entry of the run's change at its head, in entry order, then waits for DEV to report healthy, and
 * stops at the first entry that does not pass. The anchor reads the run's gate, every other entry its own repo's gate; an entry
 * with no gate declares no source and is recorded `undeclared`, never skipped silently. Returns the message of the failure, naming
 * the repo in a run over several, and the facts read up to it.
 */
async function verifyEntryDeploys(ctx: RunContext): Promise<{ failure?: string; facts: EntryFact[] }> {
  const { entries, anchor } = ctx.input.changeSet;
  const facts: EntryFact[] = [];
  const messageOf = (repo: string, error: Error): string => (entries.length > 1 ? `${repo}: ${error.message}` : error.message);
  for (const entry of entries) {
    const gate = entry === anchor ? ctx.deps.deployGate : ctx.deps.companionDeployGates?.get(entry.repo);
    if (!gate) {
      facts.push({ repo: entry.repo, state: "undeclared" });
      continue;
    }
    /* One clock for the entry: the version wait and the health wait that follows it end at the same deadline. */
    const startedAt = Date.now();
    const verified = await gate.verifyServed(entry === anchor ? ctx.input.sha : entry.headSha, { source: ctx.input.source, startedAt });
    if (!isOk(verified)) {
      if (verified.error instanceof DeployNotServedError) facts.push({ repo: entry.repo, ...verified.error.fact });
      return { failure: messageOf(entry.repo, verified.error), facts };
    }
    facts.push({ repo: entry.repo, ...verified.value });
    /* An unreadable source is recorded and never waited for as a version, but it is not healthy either: no run spends a generation against a DEV whose declared source does not answer. */
    const healthy = await gate.waitUntilHealthy({ startedAt });
    if (!isOk(healthy)) return { failure: messageOf(entry.repo, healthy.error), facts };
  }
  return { facts };
}

/* The run's record: the anchor's fact and the other entries' beside it. None when the gate ended the run before it read the anchor. */
function servedVersionSignalOf(ctx: RunContext, facts: readonly EntryFact[]): ServedVersionSignal | undefined {
  const { anchor } = ctx.input.changeSet;
  const own = facts.find((fact) => fact.repo === anchor.repo);
  if (own === undefined) return undefined;
  const { repo: _anchor, ...fact } = own;
  const companions = facts.filter((other) => other.repo !== anchor.repo);
  return companions.length > 0 ? { ...fact, companions } : fact;
}

/* The gate phase's span says what DEV served; a repo the gate stopped at before the anchor is read is still named. */
function annotateServedVersion(ctx: RunContext, facts: readonly EntryFact[]): void {
  const { anchor } = ctx.input.changeSet;
  const own = facts.find((fact) => fact.repo === anchor.repo);
  const companions = facts.filter((fact) => fact.repo !== anchor.repo).map((fact) => `${fact.repo}:${fact.state}`);
  try {
    ctx.trail.spans.annotate({
      ...(own !== undefined
        ? {
            "qayaba.served_version.state": own.state,
            ...(own.reason !== undefined ? { "qayaba.served_version.reason": own.reason } : {}),
            ...(own.served !== undefined ? { "qayaba.served_version.served": own.served } : {}),
            ...(own.waitedMs !== undefined ? { "qayaba.served_version.waited_ms": own.waitedMs } : {}),
          }
        : {}),
      ...(companions.length > 0 ? { "qayaba.served_version.companions": companions } : {}),
    });
  } catch (cause) {
    engineLog.error(`[qa] the served-version fact could not be traced (the run goes on): ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/*
 * The mid-run DEV health pre-flight over the same gates: each entry's declared source must report DEV healthy. A deploy-triggered run
 * whose entry was `equal` also holds DEV to that commit, so a newer deploy that landed since ends the run, as it always did; the
 * re-read is then recorded on the entry's fact. Every other run and entry state is held to health only. Returns the failure
 * message, or undefined when all pass.
 */
export async function awaitEntryHealth(state: Readonly<RunState>, ctx: RunContext): Promise<string | undefined> {
  const { entries, anchor } = ctx.input.changeSet;
  for (const entry of entries) {
    const gate = entry === anchor ? ctx.deps.deployGate : ctx.deps.companionDeployGates?.get(entry.repo);
    if (!gate) continue;
    const entered = entry === anchor ? state.run.servedVersion : state.run.servedVersion?.companions?.find((fact) => fact.repo === entry.repo);
    const servedSha = ctx.input.source === "webhook" && entered?.state === "equal" ? (entry === anchor ? ctx.input.sha : entry.headSha) : undefined;
    const result = await gate.waitUntilHealthy(servedSha !== undefined ? { servedSha } : {});
    if (isOk(result)) continue;
    if (result.error instanceof DeployNotServedError) recordAtExecution(state, entry.repo === anchor.repo, entry.repo, result.error.fact);
    return entries.length > 1 ? `${entry.repo}: ${result.error.message}` : result.error.message;
  }
  return undefined;
}

/* What the check before Playwright read when DEV no longer served the run's commit, on the fact of the entry it concerns. */
function recordAtExecution(state: Readonly<RunState>, isAnchor: boolean, repo: string, read: ServedVersionFact): void {
  const signal = state.run.servedVersion;
  if (signal === undefined) return;
  const { atExecution: _earlier, ...atExecution } = read;
  if (isAnchor) recordRunFact(state, "servedVersion", { ...signal, atExecution });
  else recordRunFact(state, "servedVersion", { ...signal, companions: signal.companions?.map((fact) => (fact.repo === repo ? { ...fact, atExecution } : fact)) ?? [] });
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

/* The finished runs of the app whose phases set the reserves (the median of what they took). */
const RECENT_RUNS_FOR_RESERVE = 20;

/* Armed here, after a classify-skip has returned without spending any agent time: the countdown counts from the end of classification. */
export async function armRunDeadline(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { diff } = state.classification;
  ctx.services.intentState.tokens = changeTokens(diff ?? "");
  const deadline = ctx.deps.runDeadline;
  const scope = { mode: ctx.input.mode };
  deadline?.arm(scope);
  /* The kind of run it is bounded as: the history it reads, and the one later runs read of it, is that kind's. */
  const budget = runTimeBudgetKey(scope);
  if (deadline) recordRunFact(state, "timeBudget", budget);
  /* What the phases after each purpose need is what this app's recent runs took. A history that cannot be read leaves every reserve on its fallback, loudly. */
  if (deadline?.measure && ctx.deps.phaseHistory) {
    try {
      deadline.measure(await ctx.deps.phaseHistory.recentPhaseRecords({ app: ctx.input.app, budget, limit: RECENT_RUNS_FOR_RESERVE }));
    } catch (err) {
      engineLog.error(`[qa] the app's recent phase durations could not be read; every reserve falls back to a share of the time left: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
        else engineLog.warn("[qa] the primary repo's commit could not be read; it is not indexed this run");
      } catch (err) {
        engineLog.warn("[qa] the primary repo's commit could not be read; it is not indexed this run:", { error: err });
      }
    }
    /* Every other service entry of the change is indexed at its own head. */
    for (const entry of input.changeSet.entries) {
      const dir = deps.codeGraphRepoDirs?.get(entry.repo);
      if (dir && dir !== sourceDir && entry !== input.changeSet.anchor) await indexOne(ctx, deps.codeGraph, dir, entry.headSha.toString());
    }
  }
}

/* Indexes one repo at a commit and records it; the record, or undefined when the engine threw (logged, never a failure of the run). */
export async function indexOne(ctx: WorkspaceRunContext, codeGraph: CodeGraphPort, repoDir: string, sha: string): Promise<CodeGraphIndexRecord | undefined> {
  let record: CodeGraphIndexRecord;
  try {
    record = await codeGraph.syncTo(repoDir, sha, ctx.signal);
  } catch (err) {
    engineLog.warn("[qa] code-graph indexing failed (non-blocking):", { error: err });
    return undefined;
  }
  if (record.outcome === "failed" || record.outcome === "timeout") engineLog.warn(`[qa] code-graph indexing of ${record.repo} ${record.outcome} (non-blocking): ${record.reason ?? "no reason given"}`);
  recordIndex(ctx, record);
  return record;
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
    engineLog.error(`[telemetry] the code-graph index span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
  telemetry.counter("qayaba.code_graph.index")(1, { "qayaba.code_graph.outcome": record.outcome });
}
