/* The validate, health and execute phases of a run: the static gate with its bounded repair, the DEV pre-flight, the login that signs in just before the specs run, and the primary execution. */

import { CORRECTION_ORIGIN } from "../../coordination/lead-correction.ts";
import { stripAnsi } from "@kernel/ansi.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { isOk } from "@kernel/result.ts";
import { detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";
import { MAX_STATIC_FIX_ROUNDS } from "../../../domain/helpers/derive-cycle-backstop.ts";
import { reviewerApprovalOf } from "../../ports/index.ts";
import type { ExecutionPort, ValidationPort } from "../../ports/index.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import { throwIfAborted } from "../abort.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { closedLoopSignal, loopClosedNow, regenerate, staticGateFindings } from "./generation-services.ts";

type Result = Promise<StepOutcome<RunState>>;

const STATIC_GATE_ERROR_DETAIL_MAX_CHARS = 4000;

/* No selector is blocked by a static look at the specs: the pre-exec ambiguity check is advisory. */
export const DETERMINISTIC_SELECTOR_BLOCKS = 0;

/* The specs the run has delivered so far, as the gates are told. */
export const deliveredNow = (ctx: WorkspaceRunContext): { deliveredSpecs: string[] } => ({ deliveredSpecs: ctx.generation.delivered.map((d) => d.file) });

/* Live per-case ObserverPort events during execute(). Absent observer: callbacks are no-ops. */
export function liveExecutionOptions(ctx: WorkspaceRunContext) {
  const { deps, signal } = ctx;
  return {
    ...(signal ? { signal } : {}),
    onCase: (c: QaCase) => {
      deps.observer?.onEvent(
        c.status === "pass"
          ? { type: "test.passed", name: c.name, durationMs: c.durationMs ?? 0 }
          : c.status === "fail"
            ? { type: "test.failed", name: c.name, detail: c.detail, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) }
            : { type: "test.flaky", name: c.name, attempts: 2 },
      );
    },
    onRunning: (title: string) => {
      deps.observer?.onEvent({ type: "test.started", name: title });
    },
    onDiscovered: (title: string, file?: string) => {
      deps.observer?.onEvent({ type: "test.discovered", name: title, ...(file ? { file } : {}) });
    },
  };
}

/* The execution an acceptance spends: the run's live observer and signal travel with it, as on every other call. */
export const executeAccepted = (ctx: WorkspaceRunContext): ExecutionPort["execute"] => (specDir, opts) =>
  ctx.deps.execution.execute(specDir, {
    ...liveExecutionOptions(ctx),
    ...(opts === undefined ? {} : opts instanceof AbortSignal ? { signal: opts } : opts),
  });

/* The static gate an acceptance spends. */
export const validateAccepted = (ctx: WorkspaceRunContext): ValidationPort["validate"] => (specDir, changedFiles) =>
  ctx.deps.validation.validate(specDir, changedFiles, deliveredNow(ctx));

/* Mid-run DEV pre-flight, distinct from the entry gate. Absent DeployGatePort (static sites / code) defaults to always-healthy. The failure's message comes back with it. */
export async function checkDevHealth(ctx: WorkspaceRunContext): Promise<{ healthy: true } | { healthy: false; reason: string }> {
  if (!ctx.deps.deployGate) return { healthy: true };
  const result = await ctx.deps.deployGate.waitUntilServing(ctx.input.sha);
  return isOk(result) ? { healthy: true } : { healthy: false, reason: result.error.message };
}

/* What every exit of these phases tells the persisted outcome about the run so far. */
async function endingEvidence(state: Readonly<RunState>, ctx: WorkspaceRunContext) {
  const { services } = ctx;
  const { lastGenerated, retries } = state.execution;
  const { preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed } = state.generation;
  return {
    reviewerApproved: reviewerApprovalOf(lastGenerated),
    /* Static-fix retries consumed before the exit. */
    retries,
    groundingSignals: { preExecAmbiguityCatches, deterministicSelectorBlocks: DETERMINISTIC_SELECTOR_BLOCKS, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed },
    /* Retrieved ids reach the persisted outcome for diagnosability only. */
    rulesRetrieved: state.grounding.retrievedRuleIds,
    diffArchetypes: state.grounding.diffArchetypes,
    archetype: detectArchetype(state.classification.diff, state.classification.intent?.changedFiles ?? []),
    confinement: services.confinement.totals,
    /* FixLoop has not run: the tested section is the latest generation's. */
    tested: lastGenerated.specMetas,
    closedLoop: await closedLoopSignal(ctx),
    agentBrowser: ctx.trail.agentBrowser?.signals(),
  };
}

/*
 * Infra-error between validation and execute (DEV down, login broken): specs were already
 * generated, so the run is persisted like any other terminal but never folds or reflects.
 * This exit persists static:false even though validation already passed — the stored field
 * for this source is false.
 */
async function preExecuteInfraError(state: Readonly<RunState>, ctx: WorkspaceRunContext, reason: string, ending: { preconditionFailed?: boolean } = {}): Result {
  return end("pre-execute-infra", {
    generating: state.classification.generating,
    ...(await endingEvidence(state, ctx)),
    note: reason,
    ...(ending.preconditionFailed ? { preconditionFailed: true } : {}),
  });
}

/*
 * Bounded repair of static-gate errors (MAX_STATIC_FIX_ROUNDS). Skipped when
 * nothing was generated. Repair rounds get validation errors as fixCases; the
 * initial generate() does not. lastGenerated is the latest attempt's approved flag.
 * changedFiles scopes the code-target compile gate; ignored by e2e. Empty outside diff mode.
 */
export async function validateStatically(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, signal } = ctx;
  const { generating } = state.classification;
  const validateChangedFiles = state.classification.intent?.changedFiles ?? [];
  deps.observer?.onStep("validate");
  let validation = await deps.validation.validate(workspace.specDir, validateChangedFiles, deliveredNow(ctx));
  if (generating) validation = await withLinterFixes(validation, ctx, validateChangedFiles);
  let lastGenerated = state.generation.generated;
  let retries = state.execution.retries;
  let staticFixRounds = 0;
  /* What the rounds repair: the specs the run has delivered, or those the last generation reported; a repair that returned nothing leaves the delivered ones to repair. */
  const hasDelivered = () => ctx.generation.delivered.length > 0 || lastGenerated.specs.length > 0;
  /* The same reasoning: a failing gate on a spec the generator saw pass ends the run invalid instead of rewriting the spec. */
  const staticFixRetired = !validation.ok && !validation.infra && generating && hasDelivered() && (await loopClosedNow(ctx));
  if (staticFixRetired) {
    deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] the static gate failed, but every delivered spec was seen passing through run_spec: no static-fix rounds" });
  }
  while (!staticFixRetired && !validation.ok && !validation.infra && generating && hasDelivered() && staticFixRounds < MAX_STATIC_FIX_ROUNDS) {
    /* Cancel mid-repair must stop before burning another generate()+validate() round-trip. */
    throwIfAborted(signal);
    staticFixRounds++;
    /* mutation-scope:begin static-fix-round */
    retries++;
    deps.observer?.onStep("retry", `static-fix round ${staticFixRounds}/${MAX_STATIC_FIX_ROUNDS}`);
    /* Repair regen reuses the same classificationDiff/intent as the initial generate(). */
    /* mutation-scope:end static-fix-round */
    const staticGateErrorDetail = stripAnsi(validation.errors.join("\n\n")).slice(0, STATIC_GATE_ERROR_DETAIL_MAX_CHARS);
    lastGenerated = await regenerate(state, ctx, signal, {
      fixCases: [{ name: "static-gate", status: "fail", detail: staticGateErrorDetail }],
    }, CORRECTION_ORIGIN.STATIC_GATE, staticGateFindings(validation.errors.map(stripAnsi)));
    await ctx.services.confinement.enforce();
    validation = await withLinterFixes(await deps.validation.validate(workspace.specDir, validateChangedFiles, deliveredNow(ctx)), ctx, validateChangedFiles);
  }
  const execution = { ...state.execution, validation, lastGenerated, retries };

  if (!validation.ok) {
    /*
     * Context-mode validate() failure does not persist (Issue only).
     * validation.infra is infra-error: the gate itself could not run, not a code defect.
     */
    console.error("[qa] static gate failed:", validation.errors);
    const staticGateNote = validation.errors.slice(0, 2).join("\n\n") || undefined;
    return end(validation.infra ? "pre-execute-infra" : "static-gate-failed", {
      generating,
      ...(await endingEvidence({ ...state, execution }, ctx)),
      note: staticGateNote,
    });
  }
  return { update: { execution } };
}

/* The linter's own fixes, applied to the delivered specs before an agent turn is spent on the static gate; the gate runs again on what they made, and only what they leave goes to a repair turn. */
async function withLinterFixes(validation: Awaited<ReturnType<WorkspaceRunContext["deps"]["validation"]["validate"]>>, ctx: WorkspaceRunContext, changedFiles: string[]): Promise<typeof validation> {
  const { deps, workspace } = ctx;
  const run = deliveredNow(ctx);
  if (validation.ok || validation.infra || !deps.validation.autofix || run.deliveredSpecs.length === 0) return validation;
  const fixed = await deps.validation.autofix(workspace.specDir, run);
  if (fixed.length === 0) return validation;
  deps.observer?.onEvent({ type: "log.line", level: "info", text: `[qa] the linter fixed ${fixed.length} delivered spec(s); the static gate runs again on them` });
  return await deps.validation.validate(workspace.specDir, changedFiles, run);
}

/* Mid-run DEV pre-flight: a DEV that is down ends the run before the specs run. */
export async function checkHealth(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps } = ctx;
  deps.observer?.onStep("health");
  const health = await checkDevHealth(ctx);
  if (!health.healthy) {
    const healthReason = health.reason;
    console.error("[qa] health pre-flight failed before execute:", healthReason);
    return await preExecuteInfraError(state, ctx, healthReason);
  }
}

/*
 * Context mode never executes — context.json is not a Playwright spec.
 * The login signs in just before the specs run; only such a file is kept by the suite store, so its hash is recorded.
 */
export async function prepareExecuteAuth(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { workspace, signal } = ctx;
  const auth = await ctx.host.prepareAuth(workspace.specDir, "pre-execute", signal);
  if ("failed" in auth) return await preExecuteInfraError(state, ctx, auth.failed);
  if ("precondition" in auth) {
    /* Reached only by a run that generates tests (the guard above), which a failed login always ends. */
    ctx.host.announcePrecondition(auth.precondition, true);
    return await preExecuteInfraError(state, ctx, ctx.host.preconditionNote(auth.precondition), { preconditionFailed: true });
  }
  return { update: { execution: { ...state.execution, authVerifiedSha256: auth.setupSha256 } } };
}

export async function announceExecution(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  ctx.deps.observer?.onStep("execute");
}

/* The primary pass. A successful context generation is an immediate pass with zero cases. */
export async function executeSpecs(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace, services } = ctx;
  const run = input.mode === "context"
    ? { verdict: "pass" as const, cases: [] as QaCase[], logs: state.generation.generated.note ?? "" }
    : await deps.execution.execute(workspace.specDir, liveExecutionOptions(ctx));
  /* The primary pass just ran: its bytes fix the contract every later regeneration is measured against (A5). */
  await services.primeIntentBaseline();
  return { update: { execution: { ...state.execution, run } } };
}
