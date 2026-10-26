/*
 * RunQaUseCase drives the QA run lifecycle through segregated ports.
 * A declared no-op with zero specs is skipped, never invalid; zero specs
 * without a decision, or after the step budget ran out, is infra-error.
 * Change-coverage "unknown"
 * never blocks publish. Classify runs only in diff mode; cleanup only when
 * previousNamespace is set. Coordination fails open to GenerationPort.
 * Pre-exec gateSignals use the number 0, not undefined, when unwired.
 */

import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../../shared-infrastructure/run-secret-redaction.ts";
import { isSandboxUnavailable } from "../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { activeExecScope, refusedScope, sandboxRefused, sandboxSignal, withExecScope, type ExecScopePort } from "../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import type { AuthSession } from "@contexts/app-catalog/application/index.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { RunPhaseCursor, recordPhaseSnapshot, type PhaseClock, type RunPhase } from "../domain/run-phase-cursor.ts";
import { PhaseSpans } from "./run-phase-spans.ts";
import { runFlow, type FlowHooks } from "./run-flow/run-flow.ts";
import { actionFor, carryOn } from "./run-flow/failure-policy.ts";
import { failureEnd } from "./run-flow/failure-ends.ts";
import { degradeFailedStep } from "./run-flow/degrade.ts";
import { checkpointOf } from "./run-flow/checkpoint.ts";
import { reviewsTests } from "./run-flow/phases/review.steps.ts";
import type { StepId } from "./run-flow/step-ids.ts";
import { type RunEnd } from "./run-flow/run-end.ts";
import { finalizeRun, recordCrashEvidence } from "./run-flow/finalize-run.ts";
import type { RunState } from "./run-flow/run-state.ts";
import { initialRunState } from "./run-flow/run-state.ts";
import { recordCoordination, recordProof, recordRunFact } from "./run-flow/reducers.ts";
import { createRunServices } from "./run-flow/run-services.ts";
import type { RunContext, RunHost, WorkspaceRunContext } from "./run-flow/run-context.ts";
import { BEFORE_WORKSPACE, IN_WORKSPACE } from "./run-flow/run-steps.ts";
import { DEMOTE_REASON } from "@kernel/ports/suite-store.port.ts";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { RedactionScope } from "@kernel/telemetry/telemetry.port.ts";
import { attachTraceFacts, type RunTraceFacts } from "@kernel/run-trace-facts.ts";
import { generationRunsReviewer } from "@contexts/generation/application/index.ts";
import { AuthPreconditionError } from "@contexts/app-catalog/application/index.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";
import type { PreconditionFailure, RunQaConfig, RunQaUseCaseDeps, RunQaInput, RunQaResult, RunTrail } from "./run-flow/run-types.ts";

export type { PreconditionFailure, RunQaConfig, RunQaUseCaseDeps, RunQaInput, RunQaResult, RunTrail } from "./run-flow/run-types.ts";

const SYSTEM_PHASE_CLOCK: PhaseClock = { now: () => Date.now() };

/*
 * The fallback a run gets when a composition passes no config at all. The review-loop master switch's
 * product default (on, opt-out) is resolved where `qa.reviewLoopIntegrity` lives — the app config, read by
 * buildCompositionConfig and the composition root, both of which default it to true. This
 * fallback keeps the pre-switch flow for a caller that states nothing, so a missing config never grants
 * a slice silently; every composition that runs a real app states it.
 */
const DEFAULT_CONFIG: RunQaConfig = {
  needsReview: false,
  shadow: false,
  onFailure: "github-issue",
  maxRetries: 2,
  isCode: false,
  reviewLoopIntegrity: false,
  coveragePolicyMode: "signal",
  intentLock: { mode: "signal", opacityFlagRatio: 0.5 },
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
    try {
      sandbox = await this.deps.execScope?.open({ runId: input.runId });
    } catch (err) {
      /* The scope could not be made because the sandbox is not safe to run in (a process of an earlier run still holds the sandbox uid): the run ends E-SANDBOX without executing anything. */
      if (!isSandboxUnavailable(err)) throw err;
      return await withRunSecretScope(secrets, () =>
        withExecScope(refusedScope(input.runId, err.reason === "scope" ? "uid" : err.reason), async () => {
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
    const spans = new PhaseSpans({ telemetry: this.telemetry, secrets, app: input.app, mode: input.mode });
    const phases = new RunPhaseCursor(this.deps.phaseClock ?? SYSTEM_PHASE_CLOCK, spans);
    return { phases, spans };
  }

  /* The run's state as it begins: what the generation decides about the reviewer is known from the input and the configuration. */
  private stateOf(input: RunQaInput): RunState {
    const state = initialRunState();
    recordRunFact(state, "reviewRequired", generationRunsReviewer({ needsReview: { ...DEFAULT_CONFIG, ...this.deps.config }.needsReview, mode: input.mode }));
    return state;
  }

  private async runInScope(input: RunQaInput, secrets: RedactionScope, signal?: AbortSignal): Promise<RunQaResult> {
    const trail = this.trailOf(input, secrets);
    const state = this.stateOf(input);
    const { spans, phases } = trail;
    /* A child the launcher starts for this run is a child of whichever phase is open. */
    const scope = activeExecScope();
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
        console.error(`[qa] the crash could not be described for the trace (the run's failure stands): ${traceErr instanceof Error ? traceErr.message : String(traceErr)}`);
      }
      throw err;
    } finally {
      phases.close();
      await this.releaseGeneratorSession();
      await this.closeCoordinatedPass(trail);
      await this.closeClosedLoop(trail);
      await this.closeAgentBrowser(trail);
      this.closeCodeGraphTools(trail);
      this.closeGeolocation(trail);
      this.sayDeniedHosts();
    }
  }

  /* How the run ended, for its trace: the decision, the end of generation, and the limit that fired (the deadline's own, else the one the generation end names). A run that threw before a result was built has no decision. */
  private traceFactsOf(result: RunQaResult | undefined, state: Readonly<RunState>): RunTraceFacts {
    const end = state.run.generationEnd;
    const fromEnd = end === GENERATION_END.EXHAUSTED ? { fired: "step-cap", role: "qa-generator" } : end === GENERATION_END.TIME_BUDGET ? { fired: "tier-budget", role: "qa-generator" } : undefined;
    const limit = state.run.limit ?? fromEnd;
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    return {
      ...(result ? { decision: result.decision.sideEffect } : {}),
      ...(state.run.reviewRequired !== undefined ? { reviewRequired: state.run.reviewRequired } : {}),
      coverage: { ...(state.coverage.coverageStatus ? { status: state.coverage.coverageStatus } : {}), mode: cfg.coveragePolicyMode, ...(cfg.coverageMinRatio !== undefined ? { minRatio: cfg.coverageMinRatio } : {}) },
      ...(end !== undefined ? { generationEnd: end } : {}),
      ...(state.run.endReason !== undefined ? { endReason: state.run.endReason } : {}),
      ...(limit ? { limitFired: limit.fired, limitRole: limit.role } : {}),
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
      console.error(`[qa] the pre-execution gates could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
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
    } catch (err) {
      console.error(`[qa] the armed deadline could not be described for the trace (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
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
      console.error(`[qa] the phase record could not be attached (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
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
    if (ctx.signal?.aborted || sandboxSignal() === undefined) return;
    const kind = err instanceof Error && err.name ? err.name : "an error";
    try {
      await recordCrashEvidence(`The run ended on ${kind} before it reached a verdict; only what the sandbox saw is kept here.`, ctx, state);
    } catch (persistErr) {
      console.error(`[qa] could not persist the sandbox evidence of a run that ended on an error: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
    }
  }

  /* Says once, at the end of a run, which hosts the egress filter refused: the operator reads from it what to declare in dev.allowedOrigins. */
  private sayDeniedHosts(): void {
    const denied = sandboxSignal()?.denied ?? [];
    if (denied.length === 0) return;
    const shown = denied.slice(0, DENIED_HOSTS_SHOWN).map(printableHost);
    const more = denied.length > shown.length ? ` (and ${denied.length - shown.length} more)` : "";
    const text = `[qa] sandbox: egress denied ${denied.length} host(s): ${shown.join(", ")}${more}`;
    console.warn(text);
    this.deps.observer?.onEvent({ type: "log.line", level: "warn", text });
  }

  /* Ends the generator session the run kept for its regenerations. A fault is said and never changes how the run ended. */
  private async releaseGeneratorSession(): Promise<void> {
    try {
      await this.deps.generation.release?.();
    } catch (err) {
      console.error(`[qa] releasing the generator session failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* Revokes the browser's right and stops it. A fault is said and never changes how the run ended. */
  private async closeAgentBrowser(trail: RunTrail): Promise<void> {
    const browser = trail.agentBrowser;
    if (!browser) return;
    trail.agentBrowser = undefined;
    try {
      await browser.close();
    } catch (err) {
      console.error(`[qa] closing the agent browser failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* What the lead routed of the reviewer's corrections, recorded with the run's coordination. */
  private recordCorrections(state: RunState, trail: RunTrail): void {
    const corrections = trail.coordinatedPass?.tally();
    const { coordination } = state;
    if (coordination && corrections && corrections.turns > 0) recordCoordination(state, { ...coordination, corrections });
  }

  /* Releases the coordinated pass: the lead's session and every flow's session, workspace, loop and location. A fault is said and never changes how the run ended. */
  private async closeCoordinatedPass(trail: RunTrail): Promise<void> {
    const pass = trail.coordinatedPass;
    if (!pass) return;
    trail.coordinatedPass = undefined;
    await pass.release().catch((err: unknown) => console.error(`[qa] releasing the coordinated pass failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`));
  }

  /* Revokes the lead's code-graph tools and says what the run made of them. A fault is said and never changes how the run ended. */
  private closeCodeGraphTools(trail: RunTrail): void {
    const tools = trail.codeGraphTools;
    if (!tools) return;
    trail.codeGraphTools = undefined;
    try {
      const used = tools.signals();
      tools.close();
      console.log(`[qa] code-graph tools: ${used.calls} call(s), ${used.refused} refused, ${used.failed} the graph could not answer`);
    } catch (err) {
      console.error(`[qa] closing the code-graph tools failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
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
      console.error(`[qa] closing the authoring location failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
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
      console.error(`[qa] closing the run_spec loop failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
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
    /*
     * A zero agentTimeoutMs with no YAML override derives to WallClockBudget.unbounded() —
     * exhausted() then never fires, so a caller here needs no separate "is this armed" guard.
     */
    const wallClockBudget = WallClockBudget.derive({
      cycleBudget,
      agentTimeoutMs: cfg.agentTimeoutMs ?? 0,
      ...(cfg.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: cfg.wallClockBudgetMs } : {}),
    });
    const host: RunHost = {
      recordCoordination: (coordinationSignal) => recordCoordination(state, coordinationSignal),
      recordCorrections: () => this.recordCorrections(state, trail),
      closeCoordinatedPass: () => this.closeCoordinatedPass(trail),
      noteGroundingGates: (result) => this.noteGroundingGates(trail, result),
      pruneMirror: (mirrorDir) => this.pruneMirrorIfWired(mirrorDir),
      noteDeadlineArmed: () => this.noteDeadlineArmed(trail),
      redact: (text) => redactByValue(text),
      prepareAuth: (specDir, phase, abortSignal) => this.prepareAuth(specDir, phase, abortSignal),
      replaceRestoredLogin: (workspace, abortSignal) => this.replaceRestoredLogin(workspace, abortSignal),
      announceSuite: (text, level) => this.announceSuite(text, level),
      announcePrecondition: (failure, ends) => this.announcePrecondition(failure, ends),
      preconditionNote: (failure) => this.preconditionNote(failure),
      coordination: () => state.coordination,
      sandboxRefused: () => sandboxRefused(),
      sandboxSignal: () => sandboxSignal(),
    };
    return { input, signal, trail, deps: this.deps, telemetry: this.telemetry, cfg, startedAt, cycleBudget, wallClockBudget, host };
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
        return degradeFailedStep(reason, err, stepId, current, { reviewRequired: reviewsTests(baseCtx) && current.classification.generating, endOf: (endReason, cause) => failureEnd(endReason, cause, baseCtx, state) });
      },
      enter: (phase: RunPhase) => trail.phases.enter(phase),
      record: (event) => {
        trail.spans.step({
          "qayaba.run_step.id": event.id,
          "qayaba.run_step.outcome": event.outcome,
          ...(event.outcome === "ended" ? { "qayaba.run_step.reason": event.reason } : {}),
        });
        this.deps.stateObserver?.(state, event);
        if (this.deps.onCheckpoint) this.deps.onCheckpoint(checkpointOf(state, live, event.id));
      },
    };

    const opening = await runFlow(BEFORE_WORKSPACE, state, baseCtx, hooks);
    if ("end" in opening) return await this.finalize(opening.end, baseCtx, state);

    trail.phases.enter("workspace");
    const workspace = await this.deps.workspace.prepare(input.sha);
    recordRunFact(state, "mirrorDir", workspace.mirrorDir);
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
      if (err instanceof AuthPreconditionError) {
        /* Its own fields only: a login failure never prints the error object, which could carry anything a page or a network said. */
        console.error(`[qa] auth precondition failed${phase === "pre-execute" ? " before execute" : ""}: kind=${err.kind} note=${err.note} ms=${err.ms}`);
        return { precondition: { kind: err.kind, note: err.note, ms: err.ms } };
      }
      console.error(`[qa] auth session failed${phase === "pre-execute" ? " before execute" : ""}:`, err);
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
  private async replaceRestoredLogin(workspace: { specDir: string; mirrorDir: string }, signal?: AbortSignal): Promise<"replaced" | "unchanged" | "setup-failed"> {
    try {
      await this.deps.suiteStore!.demoteAuth(workspace, DEMOTE_REASON.LOGIN_DID_NOT_SIGN_IN);
    } catch (err) {
      carryOn(err);
      this.announceSuite(`[qa] suite store could not demote the failed login (the failure stands): ${err instanceof Error ? err.message : String(err)}`, "warn");
      return "unchanged";
    }
    this.announceSuite("[qa] the login restored from the suite store failed to sign in; the stock seed replaces it and the login is tried once more", "warn");
    if (!this.deps.setup) return "replaced";
    try {
      await this.deps.setup.setup(workspace.specDir, signal);
    } catch (err) {
      console.error("[qa] setup phase failed while replacing the restored login:", err);
      return "setup-failed";
    }
    return "replaced";
  }

  /* One line about the suite store, on the console and on the run's own log. */
  private announceSuite(text: string, level: "info" | "warn"): void {
    (level === "warn" ? console.warn : console.log)(text);
    this.deps.observer?.onEvent({ type: "log.line", level, text });
  }

  /* What a failed precondition ends the run with: its kind and scrubbed note, never any evidence. */
  private preconditionNote(failure: PreconditionFailure): string {
    return `the app's login could not be completed before testing (${failure.kind}): ${failure.note}`;
  }

  /* A failed login is always loud: an error when it ends the run, a warning when a context run carries on without a session. */
  private announcePrecondition(failure: PreconditionFailure, ends: boolean): void {
    this.deps.observer?.onEvent({
      type: "log.line",
      level: ends ? "error" : "warn",
      text: ends
        ? `[qa] the run ended before generation (${failure.kind}) after ${failure.ms}ms: the app's login could not be completed, not a fault in the code under test`
        : `[qa] the app's login could not be completed (${failure.kind}) after ${failure.ms}ms; this context run continues without a session`,
    });
  }

  /*
   * Fault-isolated gc for every exit that already called prepare(). Entry-gate
   * exits before prepare() never call this. A thrown prune() is logged and never
   * alters the verdict.
   */
  private async pruneMirrorIfWired(mirrorDir: string): Promise<void> {
    if (!this.deps.mirrorGc) return;
    try {
      await this.deps.mirrorGc.prune(mirrorDir);
    } catch (err) {
      carryOn(err); /* a git dir that is not the orchestrator's is a security refusal, never a fault to isolate */
      console.error(
        `[qa] mirror gc FAILED (fault-isolated — run continues, never blocks publish): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
