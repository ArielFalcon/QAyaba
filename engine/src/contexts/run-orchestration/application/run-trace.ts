/*
 * The trace of one run as the runner sees it: the short `qayaba.run.enqueue` span opened in the caller's context when the run is
 * requested, and the `qayaba.run` root opened when the queue hands the run its turn.
 *
 * Context propagation, end to end. `JobQueue.enqueue` chains the job on a shared promise tail inside the enqueuer's async
 * context, so the job inherits whatever span the request was in. The root is therefore opened `root: true`, on an empty
 * context, and carries a span link to the enqueue span (OpenTelemetry's rule for a consumer that runs later than its producer).
 * The engine call runs under the root (`withParent`), so the phase spans the engine opens are its children; each phase span is
 * in turn what a sandboxed child's span is parented to (the run's exec scope).
 *
 * Observability never changes how a run ends: every call goes to a port made total (guardTelemetry).
 */
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import type { SpanHandle, TelemetryClock, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import { RunEnding, factsAttrs, identityAttrs, runLevelLimits, type HostEventListener, type RunFacts, type RunIdentity } from "../domain/run-trace.ts";
import { traceStage } from "./run-stage-spans.ts";
import { stageSpanName, type RunStage } from "@kernel/run-step.ts";
import type { HostEventsPort } from "./ports/host-events.port.ts";
import type { RunConfigInEffect } from "./recorded-run-config.ts";

export const SYSTEM_CLOCK: TelemetryClock = { now: () => Date.now() };

/* The enqueue span's position, kept with the job. */
export interface EnqueueMark {
  context: TelemetryContext | undefined;
  at: number;
}

const isDead = (context: TelemetryContext): boolean => /^0+$/.test(context.spanId);

/*
 * Opens and ends the enqueue span in the caller's context (it is a child of an active request span, when there is one). `root`
 * opens it in a trace of its own: a run tracked from inside another run's turn must not mark that run's trace as its own.
 */
export function markEnqueued(telemetry: TelemetryPort, clock: TelemetryClock, identity: RunIdentity, opts: { root?: boolean } = {}): EnqueueMark {
  const guarded = guardTelemetry(telemetry);
  const at = clock.now();
  const span = guarded.startSpan("qayaba.run.enqueue", { kind: "internal", startTime: at, attrs: identityAttrs(identity), ...(opts.root ? { root: true } : {}) });
  span.end(clock.now());
  const context = span.context();
  return { context: isDead(context) ? undefined : context, at };
}

export class RunTrace {
  private readonly telemetry: TelemetryPort;
  private readonly span: SpanHandle;
  private readonly startedAt: number;
  private readonly ending = new RunEnding();
  private ended = false;
  private suspendedMs = 0;
  private eventLoopMaxMs: number | undefined;
  private readonly unregisterHost: () => void;

  constructor(
    telemetry: TelemetryPort,
    private readonly clock: TelemetryClock,
    private readonly identity: RunIdentity,
    enqueued: EnqueueMark,
    hostEvents: HostEventsPort,
  ) {
    this.telemetry = guardTelemetry(telemetry);
    this.startedAt = clock.now();
    this.span = this.telemetry.startSpan("qayaba.run", {
      kind: "internal",
      root: true,
      startTime: this.startedAt,
      ...(identity.captureMode ? { captureMode: identity.captureMode } : {}),
      ...(enqueued.context ? { links: [{ context: enqueued.context }] } : {}),
      attrs: {
        ...identityAttrs(identity),
        "qayaba.queue.wait_ms": Math.max(0, this.startedAt - enqueued.at),
      },
    });
    this.unregisterHost = hostEvents.add(this.hostListener());
  }

  /* What the host did to the process while this run was active (one run at a time: the sequential queue). Registered for the run's length only. */
  private hostListener(): HostEventListener {
    return {
      hostSuspended: (ms, at) => {
        this.suspendedMs += ms;
        this.span.addEvent("host_suspended", { "qayaba.host.suspend_ms": Math.round(ms) }, at);
      },
      eventLoopBlocked: (ms, at) => {
        this.span.addEvent("event_loop_blocked", { "qayaba.host.blocked_ms": Math.round(ms) }, at);
      },
      eventLoopObserved: (maxMs) => {
        this.eventLoopMaxMs = Math.max(this.eventLoopMaxMs ?? 0, maxMs);
      },
    };
  }

  /* Runs the engine call under the root. */
  within<T>(fn: () => T): T {
    return this.telemetry.withParent(this.span, fn);
  }

  /* Runs a stretch of the run that is no phase (RUN_STAGES) as a `qayaba.stage.<name>` child of the root, so the root's time is explained from its first moment. */
  stage<T>(stage: RunStage, fn: () => T): T {
    return traceStage(this.telemetry, stage, fn, { parent: this.span });
  }

  /* A stage that opens only if the run reaches it (a wait it may not need), closed by the caller on every path out: the same `qayaba.stage.<name>` span `stage` makes, opened at the moment the run is in it. */
  openStage(stage: RunStage): { end(): void } {
    const span = this.telemetry.startSpan(stageSpanName(stage), { kind: "internal", parent: this.span, startTime: this.clock.now() });
    return { end: () => span.end(this.clock.now()) };
  }

  /* Known once the app's config is loaded (a request may leave it to the app's own setting). */
  shadow(shadow: boolean): void {
    this.span.setAttrs({ "qayaba.shadow": shadow });
  }

  /* Known once the run's settings are resolved (the app's config and the request's own levers). */
  configInEffect(config: RunConfigInEffect): void {
    const attrs: Record<string, string | boolean> = {};
    if (config.runtime !== null) attrs["qayaba.runtime"] = config.runtime;
    if (config.closedLoop !== null) attrs["qayaba.closed_loop.enabled"] = config.closedLoop;
    if (config.agentBrowser !== null) attrs["qayaba.agent_browser.enabled"] = config.agentBrowser;
    if (config.coveragePolicy !== null) attrs["qayaba.coverage.policy"] = config.coveragePolicy;
    if (config.campaignFreeze !== null) attrs["qayaba.campaign.freeze"] = config.campaignFreeze;
    if (config.staticPromptHash !== null) attrs["qayaba.prompt.static_hash"] = config.staticPromptHash;
    if (config.captureMode !== null) attrs["qayaba.capture_mode"] = config.captureMode;
    this.span.setAttrs(attrs);
  }

  onboardingWait(ms: number): void {
    this.span.setAttrs({ "qayaba.onboarding.wait_ms": Math.max(0, ms) });
  }

  now(): number {
    return this.clock.now();
  }

  /* The trace id of the root, or null when telemetry is off (the port then hands out an inert context). */
  traceId(): string | null {
    const context = this.span.context();
    return isDead(context) ? null : context.traceId;
  }

  /* The run reached a verdict. */
  finished(facts: RunFacts): void {
    this.ending.finished(facts);
  }

  /* An operator cancelled the run: not an error, and nothing the engine said afterwards counts. */
  cancelled(): void {
    this.ending.cancelled();
  }

  /* An exception out of the engine or the runner's own recording of the run. */
  crashed(error: unknown, errorClass: string, facts: Omit<RunFacts, "verdict" | "errorClass"> = {}): void {
    this.ending.crashed(error, errorClass, facts);
  }

  /* The root's final facts, whether the run returned a verdict or crashed. */
  private applyFacts(f: RunFacts, error?: unknown): void {
    this.span.setAttrs(factsAttrs(f));
    if (f.verdict === "infra-error") {
      this.span.recordError(error ?? Object.assign(new Error(f.errorClass ?? "infra-error"), { name: f.errorClass ?? "infra-error" }));
    }
    for (const limit of runLevelLimits(f)) {
      this.telemetry.counter("qayaba.budget.exhausted")(1, { "qayaba.limit.fired": limit.fired, ...(limit.role ? { "qayaba.agent.role": limit.role } : {}) });
    }
  }

  /* Ends the root on whatever path got here, once, then records the run's metrics and commits the local ledger. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.unregisterHost();
    const at = this.clock.now();
    const { app, mode } = this.identity;
    let verdict: string | undefined;
    let errorClass: string | undefined;
    let furthest: string | undefined;
    let infraFailure = false;
    const ending = this.ending.current;
    if (ending?.kind === "facts" || ending?.kind === "crashed") {
      const facts = ending.facts;
      verdict = facts.verdict;
      errorClass = facts.errorClass ?? undefined;
      furthest = facts.furthestPhase;
      infraFailure = facts.verdict === "infra-error";
      this.applyFacts(facts, ending.kind === "crashed" ? ending.error : undefined);
    } else if (ending?.kind === "cancelled") {
      verdict = "cancelled";
      this.span.setAttrs({ "qayaba.run.cancelled": true });
    }
    if (this.suspendedMs > 0) this.span.setAttrs({ "qayaba.host.suspended_ms": Math.round(this.suspendedMs) });
    if (this.eventLoopMaxMs !== undefined) this.span.setAttrs({ "qayaba.host.event_loop.max_ms": Math.round(this.eventLoopMaxMs) });
    this.span.end(at);
    if (verdict !== undefined) {
      this.telemetry.counter("qayaba.runs")(1, {
        "qayaba.app": app,
        "qayaba.verdict": verdict,
        "qayaba.mode": mode,
        ...(errorClass ? { "qayaba.error_class": errorClass } : {}),
        ...(furthest ? { "qayaba.furthest_phase": furthest } : {}),
      });
      this.telemetry.histogram("qayaba.run.duration")(Math.max(0, at - this.startedAt) / 1000, { "qayaba.app": app, "qayaba.verdict": verdict, "qayaba.mode": mode });
    }
    if (infraFailure) this.telemetry.counter("qayaba.infra_errors")(1, { "qayaba.error_class": errorClass ?? "E-INFRA", "qayaba.app": app });
    this.telemetry.flush();
  }
}
