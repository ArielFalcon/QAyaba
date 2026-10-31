/*
 * RunQaUseCase drives the QA run lifecycle through segregated ports.
 * A declared no-op with zero specs is skipped, never invalid; zero specs
 * without a decision, or after the step budget ran out, is infra-error.
 * Change-coverage "unknown"
 * never blocks publish. Classify runs only in diff mode; cleanup only when
 * previousNamespace is set. An e2e run that no author sidekick can serve ends `E-NO-AUTHOR`.
 * Pre-exec gateSignals use the number 0, not undefined, when unwired.
 */

import { RunDeadlineExceededError } from "../../../shared-kernel/run-deadline.ts";
import type { TurnLimit } from "../../../shared-kernel/turn-limit.ts";
import { levelOfEffect } from "@kernel/ports/logger.port.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import { PRECONDITION_EFFECT, type PreconditionTerminal } from "../domain/helpers/precondition-terminal.ts";
import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../../shared-kernel/run-secret-redaction.ts";
import { redactThenBound } from "../../../shared-kernel/redact-then-bound.ts";
import type { ExecScopePort } from "../../../shared-kernel/ports/exec-scope.port.ts";
import type { AuthSession } from "@contexts/app-catalog/application/index.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { type RunPhase } from "@kernel/run-step.ts";
import { RunPhaseCursor, recordPhaseSnapshot, type PhaseClock } from "../domain/run-phase-cursor.ts";
import { PhaseSpans } from "./run-phase-spans.ts";
import { runFlow, type FlowHooks } from "./run-flow/run-flow.ts";
import { actionFor, carryOn, cutByDeadline } from "./run-flow/failure-policy.ts";
import { failureEnd } from "./run-flow/failure-ends.ts";
import { degradeFailedStep } from "./run-flow/degrade.ts";
import { checkpointOf } from "./run-flow/checkpoint.ts";
import { reviewsTests } from "./run-flow/phases/review.steps.ts";
import { reviewRequired } from "../domain/review-required.ts";
import type { StepId } from "./run-flow/step-ids.ts";
import { type RunEnd } from "./run-flow/run-end.ts";
import { finalizeRun, recordCrashEvidence } from "./run-flow/finalize-run.ts";
import type { RunState } from "./run-flow/run-state.ts";
import type { WorkspaceHandle } from "@contexts/workspace-and-publication/application/index.ts";
import { initialRunState } from "./run-flow/run-state.ts";
import { recordCoordination, recordProof, recordRunFact } from "./run-flow/reducers.ts";
import { createRunServices } from "./run-flow/run-services.ts";
import type { RunContext, RunHost, WorkspaceRunContext } from "./run-flow/run-context.ts";
import { measuresCoverage } from "./run-flow/phases/coverage.steps.ts";
import { remeasuresStaleCoverage } from "./run-flow/phases/review.steps.ts";
import { BEFORE_WORKSPACE, IN_WORKSPACE } from "./run-flow/run-steps.ts";
import { DEMOTE_REASON } from "@kernel/ports/suite-store.port.ts";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { RedactionScope } from "@kernel/telemetry/telemetry.port.ts";
import { attachTraceFacts, primaryLimit, type RunLimitFact, type RunTraceFacts } from "@kernel/run-trace-facts.ts";
import { AuthPreconditionError } from "@contexts/app-catalog/application/index.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { DEFAULT_FIX_LOOP_MAX_RETRIES, DEFAULT_INTENT_LOCK } from "../domain/run-policy.ts";
import { DEFAULT_COVERAGE_MODE } from "@contexts/objective-signal/application/index.ts";
import type { PreconditionFailure, RunQaConfig, RunQaUseCaseDeps, RunQaInput, RunQaResult, RunTrail } from "./run-flow/run-types.ts";

export type { PreconditionFailure, RunQaConfig, RunQaUseCaseDeps, RunQaInput, RunQaResult, RunTrail } from "./run-flow/run-types.ts";

const SYSTEM_PHASE_CLOCK: PhaseClock = { now: () => Date.now() };

/* The fallback a run gets when a composition passes no config at all. */
const DEFAULT_CONFIG: RunQaConfig = {
  needsReview: false,
  shadow: false,
  onFailure: "github-issue",
  maxRetries: DEFAULT_FIX_LOOP_MAX_RETRIES,
  coveragePolicyMode: DEFAULT_COVERAGE_MODE,
  intentLock: DEFAULT_INTENT_LOCK,
};

/** What the run knows when its deadline ends it: the little a terminal outcome carries, filled in as the run learns it. */
const DENIED_HOSTS_SHOWN = 20;

/* A refused name is whatever the child asked for; it is shown only when it looks like a host. */
function printableHost(host: string): string {
  return /^[A-Za-z0-9._:\[\]-]{1,253}$/.test(host) ? host : "(unprintable name)";
}


export class RunQaUseCase {
  private readonly telemetry: TelemetryPort;

  constructor(private readonly deps: RunQaUseCaseDeps) {
    this.telemetry = guardTelemetry(deps.telemetry ?? new NoopTelemetry());
  }

  async run(input: RunQaInput, signal?: AbortSignal): Promise<RunQaResult> {
    /* The run owns the secrets of its test account: whatever learns one registers it into this scope, and the text that reaches a model has them taken out by value (run-secret-redaction.ts). */
    const secrets = createRunSecretScope();
    let sandbox: Awaited<ReturnType<ExecScopePort["open"]>> | undefined;
    const scopes = this.deps.execScope;
    try {
      sandbox = await scopes?.open({ runId: input.runId });
    } catch (err) {
      /* The scope could not be made because the sandbox is not safe to run in (a process of an earlier run still holds the sandbox uid): the run ends E-SANDBOX without executing anything. */
      if (!scopes?.isSandboxUnavailable(err)) throw err;
      return await withRunSecretScope(secrets, () =>
        scopes.withExecScope(scopes.refusedScope(input.runId, err.reason === "scope" ? "uid" : err.reason), async () => {
          const state = this.stateOf(input);
          const ctx = this.contextOf(input, undefined, this.trailOf(input, secrets), state);
          const result = await this.finalize(failureEnd("sandbox-unavailable", err, ctx, state), ctx, state);
          return attachTraceFacts(result, { endReason: "sandbox-unavailable" });
        }),
      );
    }
    try {
      return await withRunSecretScope(secrets, () => (sandbox ? sandbox.run(() => this.runInScope(input, secrets, signal)) : this.runInScope(input, secrets, signal)));
    } finally {
      sandbox?.close();
    }
  }

  /* The run's trail: its phase cursor and the spans the cursor opens, created before anything runs. */
  private trailOf(input: RunQaInput, secrets: RedactionScope): RunTrail {
    const spans = new PhaseSpans({ telemetry: this.telemetry, secrets, app: input.app });
    const phases = new RunPhaseCursor(this.deps.phaseClock ?? SYSTEM_PHASE_CLOCK, spans);
    return { phases, spans };
  }

  /* The run's state as it begins: what the generation decides about the reviewer is known from the input and the configuration. */
  private stateOf(input: RunQaInput): RunState {
    const state = initialRunState();
    recordRunFact(state, "reviewRequired", reviewRequired({ needsReview: { ...DEFAULT_CONFIG, ...this.deps.config }.needsReview, mode: input.mode }));
    return state;
  }

  private async runInScope(input: RunQaInput, secrets: RedactionScope, signal?: AbortSignal): Promise<RunQaResult> {
    const trail = this.trailOf(input, secrets);
    const state = this.stateOf(input);
    const { spans, phases } = trail;
    /* A child the launcher starts for this run is a child of whichever phase is open. */
    const scope = this.deps.execScope?.activeExecScope();
    /* Every child the launcher starts for this run is killed when the run's time is spent. */
    if (scope) scope.deadline = { signal: () => this.deps.runDeadline?.signal?.() };
    if (scope) scope.telemetry = { parent: () => spans.context(), phaseStart: () => spans.startedAt(), annotate: (attrs) => spans.annotate(attrs) };
    try {
      return this.withPhases(await this.execute(input, signal, trail, state), trail, state);
    } catch (err) {
      /* An error nothing here handles goes to the caller, which records the run: it is told where the run stood and how generation ended, so its root span carries the same facts a returned verdict would. */
      spans.fail(err);
      phases.close();
      recordPhaseSnapshot(err, phases.snapshot());
      try {
        if (typeof err === "object" && err !== null) attachTraceFacts(err, this.traceFactsOf(undefined, state));
      } catch (traceErr) {
        engineLog.error(`[qa] the crash could not be described for the trace (the run's failure stands): ${traceErr instanceof Error ? traceErr.message : String(traceErr)}`);
      }
      throw err;
    } finally {
      phases.close();
      await this.closeCoordinatedPass(trail);
      await this.closeClosedLoop(trail);
      await this.closeAgentBrowser(trail);
      this.closeCodeGraphTools(trail);
      this.closeGeolocation(trail);
      this.sayDeniedHosts();
    }
  }

  /* How the run ended, for its trace and its record: the decision and whether shadow replaced it, the end of generation, every limit that fired (the engine's own, then the one the generation end names) and every fault the run went on past. A run that threw before a result was built has no decision. */
  private traceFactsOf(result: RunQaResult | undefined, state: Readonly<RunState>): RunTraceFacts {
    const end = state.run.generationEnd;
    const fromEnd: { fired: TurnLimit; role: string } | undefined = end === GENERATION_END.EXHAUSTED ? { fired: "step-cap", role: "qa-author" } : undefined;
    const limits: RunLimitFact[] = [...state.run.limits];
    if (fromEnd && !limits.some((known) => known.fired === fromEnd.fired && known.role === fromEnd.role)) limits.push({ ...fromEnd, scope: "run" });
    const first = primaryLimit(limits);
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    return {
      ...(result ? { decision: result.decision.outcome, shadowed: result.decision.shadowed } : {}),
      ...(state.run.reviewRequired !== undefined ? { reviewRequired: state.run.reviewRequired } : {}),
      ...(state.run.timeBudget !== undefined ? { timeBudget: state.run.timeBudget } : {}),
      coverage: { ...(state.coverage.coverageStatus ? { status: state.coverage.coverageStatus } : {}), mode: cfg.coveragePolicyMode, ...(cfg.coverageMinRatio !== undefined ? { minRatio: cfg.coverageMinRatio } : {}) },
      ...(end !== undefined ? { generationEnd: end } : {}),
      ...(state.run.endReason !== undefined ? { endReason: state.run.endReason } : {}),
      limits,
      ...(first ? { limitFired: first.fired, limitRole: first.role } : {}),
      degradations: [...state.run.degradations],
    };
  }

  /* What the pre-execution gates found, as events on the phase they ran in: the ambiguity advisory and the catalog gate (its count of fabricated test ids and how many of them were fail-closed). Nothing is said when they found nothing. A fault here never reaches the run. */
  private noteGroundingGates(trail: RunTrail, result: { preExecAmbiguityCatches: number; catalogGateInWindow: number; catalogGateAdvisory: number; catalogGateFailClosed: number }): void {
    try {
      if (result.preExecAmbiguityCatches > 0) trail.spans.event("ambiguity_advisory", { "qayaba.preexec.ambiguity_catches": result.preExecAmbiguityCatches });
      if (result.catalogGateInWindow + result.catalogGateAdvisory + result.catalogGateFailClosed > 0) {
        trail.spans.event("catalog_gate", {
          "qayaba.catalog_gate.fabricated": result.catalogGateFailClosed,
          "qayaba.catalog_gate.in_window": result.catalogGateInWindow,
          "qayaba.catalog_gate.advisory": result.catalogGateAdvisory,
        });
      }
    } catch (err) {
      engineLog.error(`[qa] the pre-execution gates could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* The armed deadline, on the phase it was armed in. */
  private noteDeadlineArmed(trail: RunTrail): void {
    try {
      const armed = this.deps.runDeadline?.describe?.();
      if (!armed) return;
      const attrs = { "qayaba.deadline.label": armed.label, "qayaba.deadline.budget_ms": armed.budgetMs } as const;
      trail.spans.annotate(attrs);
      trail.spans.event("deadline_armed", attrs);
      /* The first time each purpose is allotted time, the allotment and where its reserve came from are on the trace. */
      this.deps.runDeadline?.observe?.((allotment) =>
        trail.spans.event("allotment", {
          "qayaba.allotment.purpose": allotment.purpose,
          "qayaba.allotment.ms": allotment.ms,
          "qayaba.allotment.reserve_ms": allotment.reserve.ms,
          "qayaba.allotment.reserve_source": allotment.reserve.source,
          "qayaba.allotment.unmeasured": [...allotment.reserve.unmeasured],
        }),
      );
    } catch (err) {
      engineLog.error(`[qa] the armed deadline could not be described for the trace (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /*
   * Every way a run can end carries where it got. The record is on the returned result and on a copy of its outcome; what the
   * run persisted was saved earlier and is never touched, so the run history holds no phase data (the run's record does).
   * Observability never changes how a run ended: a fault here returns the result as it was.
   */
  private withPhases(result: RunQaResult, trail: RunTrail, state: Readonly<RunState>): RunQaResult {
    try {
      const phases = trail.phases;
      phases.close();
      const { furthestPhase, phaseTimings } = phases.snapshot();
      /* The one channel for the trace's facts: the result this returns. The shell adapter hands them on to whichever outcome it returns. */
      const traceFacts = this.traceFactsOf(result, state);
      if (furthestPhase === null) return attachTraceFacts(result, traceFacts);
      return attachTraceFacts(
        {
          ...result,
          ...(result.outcome ? { outcome: { ...result.outcome, gateSignals: { ...result.outcome.gateSignals, phaseTimings, furthestPhase } } } : {}),
          gateSignals: { ...result.gateSignals, phaseTimings, furthestPhase },
        },
        traceFacts,
      );
    } catch (err) {
      engineLog.error(`[qa] the phase record could not be attached (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }

  /**
   * An error nothing here handles (an agent runtime that failed mid-turn) leaves the caller to record the run, and the caller
   * has no scope to read: the hosts the egress filter refused would be lost, and they are what an operator needs to learn
   * which origins to declare. When a child ran, an infra-error outcome carrying only that evidence is persisted before the
   * error goes on. A run that spawned nothing has no evidence and persists nothing; a cancelled run is not an error. The
   * note names the kind of error, never its text, which the caller records after redacting it. A fault here never replaces the error.
   */
  private async keepSandboxEvidence(err: unknown, ctx: RunContext, state: Readonly<RunState>): Promise<void> {
    if (ctx.signal?.aborted || this.deps.execScope?.sandboxSignal() === undefined) return;
    const kind = err instanceof Error && err.name ? err.name : "an error";
    try {
      await recordCrashEvidence(`The run ended on ${kind} before it reached a verdict; only what the sandbox saw is kept here.`, ctx, state);
    } catch (persistErr) {
      engineLog.error(`[qa] could not persist the sandbox evidence of a run that ended on an error: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
    }
  }

  /* Says once, at the end of a run, which hosts the egress filter refused: the operator reads from it what to declare in dev.allowedOrigins. */
  private sayDeniedHosts(): void {
    const denied = this.deps.execScope?.sandboxSignal()?.denied ?? [];
    if (denied.length === 0) return;
    const shown = denied.slice(0, DENIED_HOSTS_SHOWN).map(printableHost);
    const more = denied.length > shown.length ? ` (and ${denied.length - shown.length} more)` : "";
    const text = `[qa] sandbox: egress denied ${denied.length} host(s): ${shown.join(", ")}${more}`;
    engineLog.warn(text);
    this.deps.observer?.onEvent({ type: "log.line", level: "warn", text });
  }

  /* Revokes the browser's right and stops it. A fault is said and never changes how the run ended. */
  private async closeAgentBrowser(trail: RunTrail): Promise<void> {
    const browser = trail.agentBrowser;
    if (!browser) return;
    trail.agentBrowser = undefined;
    try {
      await browser.close();
    } catch (err) {
      engineLog.error(`[qa] closing the agent browser failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* What the lead routed of the reviewer's corrections, recorded with the run's coordination. */
  private recordCorrections(state: RunState, trail: RunTrail): void {
    const corrections = trail.coordinatedPass?.tally();
    const { coordination } = state;
    /* A pass that handled findings without asking the lead (no room, a spent budget) has still routed or left them. */
    if (coordination && corrections && Object.values(corrections).some((count) => count > 0)) recordCoordination(state, { ...coordination, corrections });
  }

  /* Releases the coordinated pass: the lead's session and every flow's session, workspace, loop and location. A fault is said and never changes how the run ended. */
  private async closeCoordinatedPass(trail: RunTrail): Promise<void> {
    const pass = trail.coordinatedPass;
    if (!pass) return;
    trail.coordinatedPass = undefined;
    await pass.release().catch((err: unknown) => engineLog.error(`[qa] releasing the coordinated pass failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`));
  }

  /* Revokes the lead's code-graph tools and says what the run made of them. A fault is said and never changes how the run ended. */
  private closeCodeGraphTools(trail: RunTrail): void {
    const tools = trail.codeGraphTools;
    if (!tools) return;
    trail.codeGraphTools = undefined;
    try {
      const used = tools.signals();
      tools.close();
      engineLog.info(`[qa] code-graph tools: ${used.calls} call(s), ${used.refused} refused, ${used.failed} the graph could not answer`);
    } catch (err) {
      engineLog.error(`[qa] closing the code-graph tools failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* Forgets the authoring location. A fault is said and never changes how the run ended. */
  private closeGeolocation(trail: RunTrail): void {
    const geolocation = trail.geolocation;
    if (!geolocation) return;
    trail.geolocation = undefined;
    try {
      geolocation.close();
    } catch (err) {
      engineLog.error(`[qa] closing the authoring location failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* Revokes the run_spec right and removes what its calls left. A fault is said and never changes how the run ended. */
  private async closeClosedLoop(trail: RunTrail): Promise<void> {
    const loop = trail.closedLoop;
    if (!loop) return;
    trail.closedLoop = undefined;
    try {
      await loop.close();
    } catch (err) {
      engineLog.error(`[qa] closing the run_spec loop failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* An end of the run: the state learns why, then the end becomes the run's result. */
  private async finalize(end: RunEnd, ctx: RunContext, state: Readonly<RunState>): Promise<RunQaResult> {
    recordRunFact(state, "endReason", end.reason);
    return await finalizeRun(end, ctx, state);
  }

  /* Runs the pipeline; the errors that end a run as an outcome of their own are turned into one here. */
  private async execute(input: RunQaInput, signal: AbortSignal | undefined, trail: RunTrail, state: RunState): Promise<RunQaResult> {
    const baseCtx = this.contextOf(input, signal, trail, state);
    try {
      return await this.drive(baseCtx, state);
    } catch (err) {
      /* An error from outside any step (the working copy being prepared, say) ends the run the way the policy says; one nothing classifies goes on to the caller. */
      const action = actionFor(err, "required");
      if (action.do === "end") return await this.finalize(failureEnd(action.reason, err, baseCtx, state), baseCtx, state);
      await this.keepSandboxEvidence(err, baseCtx, state);
      throw err;
    }
  }

  /* What every step of this run may use: its input, dependencies, configuration and trail, and its own ways to act on them. */
  private contextOf(input: RunQaInput, signal: AbortSignal | undefined, trail: RunTrail, state: RunState): RunContext {
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    const startedAt = Date.now();
    const cycleBudget = CycleBudget.derive({
      maxRetries: cfg.maxRetries,
      ...(cfg.iterationBudget !== undefined ? { iterationBudget: cfg.iterationBudget } : {}),
    });
    const host: RunHost = {
      recordCoordination: (coordinationSignal) => recordCoordination(state, coordinationSignal),
      recordCorrections: () => this.recordCorrections(state, trail),
      closeCoordinatedPass: () => this.closeCoordinatedPass(trail),
      noteGroundingGates: (result) => this.noteGroundingGates(trail, result),
      pruneMirror: (workspace) => this.pruneMirrorIfWired(workspace),
      noteDeadlineArmed: () => this.noteDeadlineArmed(trail),
      redact: (text) => redactByValue(text),
      boundText: (text, maxChars, marker) => redactThenBound(text, maxChars, (seen) => this.deps.redact?.(redactByValue(seen)) ?? redactByValue(seen), marker ? { marker } : {}),
      prepareAuth: (specDir, phase, abortSignal) => this.prepareAuth(specDir, phase, abortSignal),
      replaceRestoredLogin: (workspace, abortSignal) => this.replaceRestoredLogin(workspace, abortSignal),
      announceSuite: (text, level) => this.announceSuite(text, level),
      announcePrecondition: (failure, action, phase) => this.announcePrecondition(failure, action, phase),
      preconditionNote: (failure) => this.preconditionNote(failure),
      coordination: () => state.coordination,
      servedVersion: () => state.run.servedVersion,
      lessons: () => state.run.lessons,
      sandboxRefused: () => this.deps.execScope?.sandboxRefused() ?? false,
      sandboxSignal: () => this.deps.execScope?.sandboxSignal(),
    };
    return { input, signal, trail, deps: this.deps, telemetry: this.telemetry, cfg, startedAt, cycleBudget, host };
  }

  /* Walks the step tables and finalizes the end they reach. */
  private async drive(baseCtx: RunContext, state: RunState): Promise<RunQaResult> {
    const { input, signal, trail } = baseCtx;
    /* The context the next checkpoint reads: the working copy joins it once it is prepared. */
    let live: RunContext = baseCtx;
    const hooks: FlowHooks<StepId, RunState> = {
      aborted: () => signal?.aborted === true,
      endOf: (reason, err) => failureEnd(reason, err, baseCtx, state),
      degrade: async (reason, err, stepId, current) => {
        /* Nothing can correct through the coordinated pass from here on, and the run publishes next. */
        await baseCtx.host.closeCoordinatedPass();
        return degradeFailedStep(reason, err, stepId, current, { reviewRequired: reviewsTests(baseCtx) && current.classification.generating && current.execution.run?.verdict === "pass", coverageGateUndecided: baseCtx.cfg.coveragePolicyMode === "enforce" && measuresCoverage(current, baseCtx) && (current.coverage.coverageStatus === undefined || remeasuresStaleCoverage(current)), endOf: (endReason, cause) => failureEnd(endReason, cause, baseCtx, state) });
      },
      enter: (phase: RunPhase) => {
        trail.phases.enter(phase);
        this.deps.runDeadline?.enter?.(phase);
      },
      deadlineFired: () => this.deps.runDeadline?.fired?.() === true,
      deadlineCut: (stepId, cause) =>
        cutByDeadline(cause, () => {
          const armed = this.deps.runDeadline?.describe?.();
          return new RunDeadlineExceededError(armed?.budgetMs ?? 0, armed?.label ?? "unarmed", stepId, "mid-phase", {
            ...(cause !== undefined ? { cause } : {}),
            ...(this.deps.runDeadline?.currentPurpose ? { purpose: this.deps.runDeadline.currentPurpose() } : {}),
          });
        }),
      record: (event) => {
        trail.spans.step({
          "qayaba.run_step.id": event.id,
          "qayaba.run_step.outcome": event.outcome,
          ...(event.outcome === "ended" ? { "qayaba.run_step.reason": event.reason } : {}),
          ...(event.outcome === "skipped" && event.reason !== undefined ? { "qayaba.run_step.reason": event.reason } : {}),
        });
        this.deps.stateObserver?.(state, event);
        if (this.deps.onCheckpoint) this.deps.onCheckpoint(checkpointOf(state, live, event.id));
      },
    };

    const opening = await runFlow(BEFORE_WORKSPACE, state, baseCtx, hooks);
    if ("end" in opening) return await this.finalize(opening.end, baseCtx, state);

    trail.phases.enter("workspace");
    const workspace = await this.deps.workspace.prepare(input.sha);
    const services = createRunServices(this.deps, baseCtx.cfg, workspace, signal, (file, sha256) => recordProof(state, file, sha256));
    const ctx: WorkspaceRunContext = { ...baseCtx, workspace, services };
    live = ctx;
    const flow = await runFlow(IN_WORKSPACE, state, ctx, hooks);
    if ("end" in flow) return await this.finalize(flow.end, ctx, state);

    /* The table's last step ends the run, so a walk that finishes without an end is a defect in the table. */
    throw new Error("the run's steps ended without a result");
  }

  /*
   * No-op when the port is unwired. unauthored is a setup note, not a failure. A failed prepare is
   * logged and returned as the infra-error note for the caller's terminal.
   */
  private async prepareAuth(specDir: string, phase: "pre-generate" | "pre-execute", signal?: AbortSignal): Promise<{ unauthored: boolean; setupSha256?: string } | { failed: string } | { precondition: PreconditionFailure }> {
    const sessionPort = this.deps.authSession;
    const ctx = this.deps.authContext;
    if (!sessionPort || !ctx) return { unauthored: false };
    let session: AuthSession;
    try {
      session = await sessionPort.prepare({
        specDir,
        baseUrl: ctx.baseUrl,
        ...(ctx.auth ? { auth: ctx.auth } : {}),
        phase,
      }, signal);
    } catch (err) {
      if (err instanceof AuthPreconditionError) return { precondition: { kind: err.kind, note: err.note, ms: err.ms } };
      engineLog.error(`[qa] auth session failed${phase === "pre-execute" ? " before execute" : ""}:`, { error: err });
      return { failed: `auth session failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (session.unauthored) {
      this.deps.observer?.onStep("setup", "auth setup is still the seed; generation may rewrite e2e/auth.setup.ts");
    }
    return { unauthored: session.unauthored, ...(session.setupSha256 !== undefined ? { setupSha256: session.setupSha256 } : {}) };
  }

  /*
   * The login restored from the suite store failed to sign in. It is marked as no longer working, taken out of the working copy and
   * the project setup run again, which seeds the stock login. "unchanged" when the store could not be told (the original failure
   * stands), "setup-failed" when the setup that follows threw, "replaced" when the caller should try the login once more.
   */
  private async replaceRestoredLogin(workspace: WorkspaceHandle, signal?: AbortSignal): Promise<"replaced" | "unchanged" | "setup-failed"> {
    try {
      await this.deps.suiteStore!.demoteAuth(this.deps.workspace.readRoots(workspace), DEMOTE_REASON.LOGIN_DID_NOT_SIGN_IN);
    } catch (err) {
      const level = carryOn(err);
      this.announceSuite(`[qa] suite store could not demote the failed login (the failure stands): ${err instanceof Error ? err.message : String(err)}`, level);
      return "unchanged";
    }
    this.announceSuite("[qa] the login restored from the suite store failed to sign in; the stock seed replaces it and the login is tried once more", "warn");
    if (!this.deps.setup) return "replaced";
    try {
      await this.deps.setup.setup(workspace.specDir, signal);
    } catch (err) {
      engineLog.error("[qa] setup phase failed while replacing the restored login:", { error: err });
      return "setup-failed";
    }
    return "replaced";
  }

  /* One line about the suite store, on the console and on the run's own log. */
  private announceSuite(text: string, level: "info" | "warn"): void {
    (level === "warn" ? ((m: string): void => engineLog.warn(m)) : ((m: string): void => engineLog.info(m)))(text);
    this.deps.observer?.onEvent({ type: "log.line", level, text });
  }

  /* What a failed precondition ends the run with: its kind and scrubbed note, never any evidence. */
  private preconditionNote(failure: PreconditionFailure): string {
    return `the app's login could not be completed before testing (${failure.kind}): ${failure.note}`;
  }

  /* A failed login is announced once, on the process log and on the run's own log at one level. Its own fields only: the error object could carry anything a page or a network said. */
  private announcePrecondition(failure: PreconditionFailure, action: PreconditionTerminal["action"], phase: "pre-generate" | "pre-execute"): void {
    const level = levelOfEffect(PRECONDITION_EFFECT[action]);
    engineLog[level](`[qa] auth precondition failed${phase === "pre-execute" ? " before execute" : ""}: kind=${failure.kind} note=${failure.note} ms=${failure.ms}`);
    this.deps.observer?.onEvent({
      type: "log.line",
      level,
      text:
        action === "end"
          ? `[qa] the run ended before generation (${failure.kind}) after ${failure.ms}ms: the app's login could not be completed, not a fault in the code under test`
          : `[qa] the app's login could not be completed (${failure.kind}) after ${failure.ms}ms; this context run continues without a session`,
    });
  }

  /*
   * Fault-isolated gc for every exit that already called prepare(). Entry-gate
   * exits before prepare() never call this. A thrown prune() is logged and never
   * alters the verdict.
   */
  private async pruneMirrorIfWired(workspace: WorkspaceHandle): Promise<void> {
    if (!this.deps.mirrorGc) return;
    try {
      await this.deps.mirrorGc.prune(workspace);
    } catch (err) {
      const level = carryOn(err); /* a git dir that is not the orchestrator's is a security refusal, never a fault to isolate */
      engineLog[level](
        `[qa] mirror gc FAILED (fault-isolated — run continues, never blocks publish): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
