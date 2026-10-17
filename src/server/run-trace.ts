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

import type { RunVerdict } from "@kernel/run-verdict";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { SpanHandle, TelemetryClock, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port";

/* What started a run. `campaign` is reserved for the campaign driver (it enqueues through the API until then). */
export const RUN_TRIGGERS = ["webhook", "api", "cli", "campaign", "continuation", "context", "login-bootstrap"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const SYSTEM_CLOCK: TelemetryClock = { now: () => Date.now() };

export interface RunIdentity {
  runId: string;
  app: string;
  sha: string;
  mode: string;
  target: string;
  trigger: RunTrigger;
  parentRunId?: string | undefined;
  triggerRepo?: string | undefined;
  shadow?: boolean | undefined;
}

/* The enqueue span's position, kept with the job. */
export interface EnqueueMark {
  context: TelemetryContext | undefined;
  at: number;
}

/* What the engine told about how a run ended. */
export interface RunFacts {
  verdict: RunVerdict;
  errorClass: string | null;
  furthestPhase?: string | undefined;
  decision?: string | undefined;
  generationEnd?: string | undefined;
  limitFired?: string | undefined;
  limitRole?: string | undefined;
}

const DECISION_NAMES: Record<string, string> = { "shadow-log": "shadow", quarantine: "none" };

const isDead = (context: TelemetryContext): boolean => /^0+$/.test(context.spanId);

function identityAttrs(identity: RunIdentity) {
  return {
    "qayaba.run.id": identity.runId,
    "qayaba.app": identity.app,
    "qayaba.commit.sha": identity.sha,
    "qayaba.mode": identity.mode,
    "qayaba.target": identity.target,
    "qayaba.trigger": identity.trigger,
    ...(identity.parentRunId ? { "qayaba.parent_run.id": identity.parentRunId } : {}),
    ...(identity.triggerRepo ? { "qayaba.trigger_repo": identity.triggerRepo } : {}),
    ...(identity.shadow !== undefined ? { "qayaba.shadow": identity.shadow } : {}),
  } as const;
}

/* Opens and ends the enqueue span in the caller's context (it is a child of an active request span, when there is one). */
export function markEnqueued(telemetry: TelemetryPort, clock: TelemetryClock, identity: RunIdentity): EnqueueMark {
  const guarded = guardTelemetry(telemetry);
  const at = clock.now();
  const span = guarded.startSpan("qayaba.run.enqueue", { kind: "internal", startTime: at, attrs: identityAttrs(identity) });
  span.end(clock.now());
  const context = span.context();
  return { context: isDead(context) ? undefined : context, at };
}

type Ending = { kind: "facts"; facts: RunFacts } | { kind: "cancelled" } | { kind: "crashed"; error: unknown; errorClass: string };

export class RunTrace {
  private readonly telemetry: TelemetryPort;
  private readonly span: SpanHandle;
  private readonly startedAt: number;
  private ending: Ending | undefined;
  private ended = false;

  constructor(
    telemetry: TelemetryPort,
    private readonly clock: TelemetryClock,
    private readonly identity: RunIdentity,
    enqueued: EnqueueMark,
  ) {
    this.telemetry = guardTelemetry(telemetry);
    this.startedAt = clock.now();
    this.span = this.telemetry.startSpan("qayaba.run", {
      kind: "internal",
      root: true,
      startTime: this.startedAt,
      ...(enqueued.context ? { links: [{ context: enqueued.context }] } : {}),
      attrs: {
        ...identityAttrs(identity),
        "qayaba.queue.wait_ms": Math.max(0, this.startedAt - enqueued.at),
        "langfuse.trace.name": "qayaba.run",
        "langfuse.session.id": identity.app,
        "langfuse.trace.tags": [identity.app, identity.mode],
      },
    });
  }

  /* Runs the engine call under the root. */
  within<T>(fn: () => T): T {
    return this.telemetry.withParent(this.span, fn);
  }

  /* Known once the app's config is loaded (a request may leave it to the app's own setting). */
  shadow(shadow: boolean): void {
    this.span.setAttrs({ "qayaba.shadow": shadow });
  }

  onboardingWait(ms: number): void {
    this.span.setAttrs({ "qayaba.onboarding.wait_ms": Math.max(0, ms) });
  }

  now(): number {
    return this.clock.now();
  }

  /* The run reached a verdict. */
  finished(facts: RunFacts): void {
    this.ending ??= { kind: "facts", facts };
  }

  /* An operator cancelled the run: not an error, and nothing the engine said afterwards counts. */
  cancelled(): void {
    this.ending = { kind: "cancelled" };
  }

  /* An exception out of the engine or the runner's own recording of the run. It outranks a verdict set earlier (the record says infra-error then, and the trace must say the same), but never a cancel. */
  crashed(error: unknown, errorClass: string): void {
    if (this.ending?.kind === "cancelled") return;
    this.ending = { kind: "crashed", error, errorClass };
  }

  /* Ends the root on whatever path got here, once, then records the run's metrics and commits the local ledger. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const at = this.clock.now();
    const { app, mode } = this.identity;
    let verdict: string | undefined;
    let errorClass: string | undefined;
    let furthest: string | undefined;
    let infraFailure = false;
    const ending = this.ending;
    if (ending?.kind === "facts") {
      const f = ending.facts;
      verdict = f.verdict;
      errorClass = f.errorClass ?? undefined;
      furthest = f.furthestPhase;
      this.span.setAttrs({
        "qayaba.verdict": f.verdict,
        ...(f.errorClass ? { "qayaba.error_class": f.errorClass } : {}),
        ...(f.generationEnd ? { "qayaba.generation.end": f.generationEnd } : {}),
        ...(f.decision ? { "qayaba.decision": DECISION_NAMES[f.decision] ?? f.decision } : {}),
        ...(f.furthestPhase ? { "qayaba.furthest_phase": f.furthestPhase } : {}),
        ...(f.limitFired ? { "qayaba.limit.fired": f.limitFired } : {}),
      });
      if (f.verdict === "infra-error") {
        infraFailure = true;
        this.span.recordError(Object.assign(new Error(f.errorClass ?? "infra-error"), { name: f.errorClass ?? "infra-error" }));
      }
      if (f.limitFired) {
        this.telemetry.counter("qayaba.budget.exhausted")(1, { "qayaba.limit.fired": f.limitFired, ...(f.limitRole ? { "qayaba.agent.role": f.limitRole } : {}) });
      }
    } else if (ending?.kind === "cancelled") {
      verdict = "cancelled";
      this.span.setAttrs({ "qayaba.run.cancelled": true });
    } else if (ending?.kind === "crashed") {
      verdict = "infra-error";
      errorClass = ending.errorClass;
      infraFailure = true;
      this.span.setAttrs({ "qayaba.verdict": "infra-error", "qayaba.error_class": ending.errorClass });
      this.span.recordError(ending.error);
    }
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
