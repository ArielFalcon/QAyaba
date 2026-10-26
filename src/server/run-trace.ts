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
import type { CampaignIdentity } from "@kernel/campaign";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import { attrKey } from "@kernel/telemetry/attribute-registry";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { SpanHandle, TelemetryClock, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { hostListeners as processHostListeners, type HostEventListener, type HostListeners } from "../telemetry/host-listeners";

/* What started a run. `campaign` is a run that names the campaign it is a replicate of. */
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
  /* The campaign replicate this run is: recorded on the trace as data, never read to decide anything. */
  campaign?: CampaignIdentity | undefined;
  /* The content capture the run asked for, already capped by the server's ceiling. Absent: the run takes the process default. */
  captureMode?: CaptureMode | undefined;
}

/* The configuration a run started with, as the trace records it (the run's effectiveConfig carries the same facts). */
export interface RunConfigInEffect {
  runtime: string | null;
  closedLoop: boolean | null;
  agentBrowser: boolean | null;
  coveragePolicy: string | null;
  reflector: boolean | null;
  campaignFreeze: boolean | null;
  staticPromptHash: string | null;
  captureMode: string | null;
}

/* The campaign's identity as root attributes: the id, the replicate and one attribute per variant label. */
function campaignAttrs(campaign: CampaignIdentity | undefined): Record<string, string | number> {
  if (!campaign) return {};
  const out: Record<string, string | number> = { "qayaba.campaign.id": campaign.id, "qayaba.campaign.replicate": campaign.replicate };
  /* A registry template key is one dot-free segment, and a label key may hold dots: the attribute spells them as underscores (the stored variant keeps the key as given; keys differing only by '.' versus '_' collapse onto one attribute). */
  for (const [key, value] of Object.entries(campaign.variant)) out[attrKey.campaignVariant(key.replaceAll(".", "_"))] = value;
  return out;
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
  endReason?: string | undefined;
  limitFired?: string | undefined;
  limitRole?: string | undefined;
  reviewRequired?: boolean | undefined;
  coverage?: { status?: "pass" | "fail" | "unknown" | undefined; mode: string; minRatio?: number | undefined } | undefined;
  /* Delivered specs and how many of them validated/passed; absent when the run recorded none. */
  specs?: { generated: number; valid: number | null; passed?: number | undefined } | undefined;
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
    ...campaignAttrs(identity.campaign),
  };
}

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

type Ending = { kind: "facts"; facts: RunFacts } | { kind: "cancelled" } | { kind: "crashed"; error: unknown; facts: RunFacts };

export class RunTrace {
  private readonly telemetry: TelemetryPort;
  private readonly span: SpanHandle;
  private readonly startedAt: number;
  private ending: Ending | undefined;
  private ended = false;
  private suspendedMs = 0;
  private eventLoopMaxMs: number | undefined;
  private readonly unregisterHost: () => void;

  constructor(
    telemetry: TelemetryPort,
    private readonly clock: TelemetryClock,
    private readonly identity: RunIdentity,
    enqueued: EnqueueMark,
    hostListeners: HostListeners = processHostListeners,
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
        "langfuse.trace.name": "qayaba.run",
        /* A campaign's runs are one session, so the viewer groups the replicates of every arm together. */
        "langfuse.session.id": identity.campaign?.id ?? identity.app,
        "langfuse.trace.tags": [identity.app, identity.mode, ...Object.values(identity.campaign?.variant ?? {})],
      },
    });
    this.unregisterHost = hostListeners.add(this.hostListener());
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
    if (config.reflector !== null) attrs["qayaba.reflector.enabled"] = config.reflector;
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
    this.ending ??= { kind: "facts", facts };
  }

  /* An operator cancelled the run: not an error, and nothing the engine said afterwards counts. */
  cancelled(): void {
    this.ending = { kind: "cancelled" };
  }

  /* An exception out of the engine or the runner's own recording of the run. It outranks a verdict set earlier (the record says infra-error then, and the trace must say the same), but never a cancel. The facts the caller knows by then are set exactly as the normal exit sets them. */
  crashed(error: unknown, errorClass: string, facts: Omit<RunFacts, "verdict" | "errorClass"> = {}): void {
    if (this.ending?.kind === "cancelled") return;
    this.ending = { kind: "crashed", error, facts: { ...facts, verdict: "infra-error", errorClass } };
  }

  /* The root's final facts, whether the run returned a verdict or crashed: one place, so the two cannot disagree. */
  private applyFacts(f: RunFacts, error?: unknown): void {
    this.span.setAttrs({
      "qayaba.verdict": f.verdict,
      ...(f.errorClass ? { "qayaba.error_class": f.errorClass } : {}),
      ...(f.generationEnd ? { "qayaba.generation.end": f.generationEnd } : {}),
      ...(f.endReason ? { "qayaba.run.end_reason": f.endReason } : {}),
      ...(f.decision ? { "qayaba.decision": DECISION_NAMES[f.decision] ?? f.decision } : {}),
      ...(f.furthestPhase ? { "qayaba.furthest_phase": f.furthestPhase } : {}),
      ...(f.limitFired ? { "qayaba.limit.fired": f.limitFired } : {}),
      ...(f.specs
        ? {
            "qayaba.specs.generated": f.specs.generated,
            ...(f.specs.valid !== null ? { "qayaba.specs.valid": f.specs.valid } : {}),
            ...(f.specs.passed !== undefined ? { "qayaba.specs.passed": f.specs.passed } : {}),
          }
        : {}),
    });
    if (f.verdict === "infra-error") {
      this.span.recordError(error ?? Object.assign(new Error(f.errorClass ?? "infra-error"), { name: f.errorClass ?? "infra-error" }));
    }
    if (f.limitFired) {
      this.telemetry.counter("qayaba.budget.exhausted")(1, { "qayaba.limit.fired": f.limitFired, ...(f.limitRole ? { "qayaba.agent.role": f.limitRole } : {}) });
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
    const ending = this.ending;
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
