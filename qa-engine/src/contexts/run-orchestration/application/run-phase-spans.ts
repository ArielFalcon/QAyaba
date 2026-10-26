/*
 * The run's phases as spans. The phase cursor says when a phase opens and closes; this observer turns each opening into a
 * `qayaba.phase.<name>` span (INTERNAL) that starts and ends at the cursor's own clock readings, so the span and the phase
 * timing record cannot disagree. Spans are children of the run's active context (the root the runner opened), are bound to the
 * run's secret scope, and the local ledger is told to commit on every change so a hung run is visible while it hangs.
 *
 * A phase span is not made the ambient context (a phase is entered by a call in the middle of an async function, which can
 * scope nothing). Whatever starts a child for the phase asks `context()` for the open one: the execution launcher does,
 * through the run's exec scope.
 *
 * Observability never changes how a run ends: this class only calls a telemetry port that is total (guardTelemetry).
 */

import type { RunPhase } from "@kernel/run-step.ts";
import type { PhaseObserver } from "../domain/run-phase-cursor.ts";
import type { RedactionScope, SpanHandle, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";

export interface PhaseSpansDeps {
  telemetry: TelemetryPort;
  secrets: RedactionScope;
  app: string;
  mode: string;
}

export class PhaseSpans implements PhaseObserver {
  private open: { phase: RunPhase; span: SpanHandle; since: number } | undefined;
  private entered = 0;
  /* Step events that came while no phase was open; the next phase to open carries them. */
  private pendingSteps: Array<Parameters<SpanHandle["addEvent"]>[1]> = [];

  constructor(private readonly deps: PhaseSpansDeps) {}

  onEnter(phase: RunPhase, at: number): void {
    const { telemetry, secrets, app, mode } = this.deps;
    /* The enqueue span is in another trace, so the trace-level viewing attributes also ride the first span of this one (they are on the root too). */
    const traceLevel = this.entered === 0 ? { "langfuse.trace.name": "qayaba.run", "langfuse.session.id": app, "langfuse.trace.tags": [app, mode] } : {};
    this.entered += 1;
    const span = telemetry.startSpan(`qayaba.phase.${phase}`, { kind: "internal", startTime: at, secrets, attrs: { "qayaba.phase": phase, ...traceLevel } });
    this.open = { phase, span, since: at };
    for (const attrs of this.pendingSteps.splice(0)) span.addEvent("step", attrs);
    telemetry.flush();
  }

  onExit(phase: RunPhase, at: number): void {
    const open = this.open;
    this.open = undefined;
    if (!open) return;
    open.span.end(at);
    this.deps.telemetry.histogram("qayaba.phase.duration")(Math.max(0, at - open.since) / 1000, { "qayaba.phase": phase, "qayaba.app": this.deps.app });
    this.deps.telemetry.flush();
  }

  /** The open phase's position in the trace, for a child that is started elsewhere (an exec span). */
  context(): TelemetryContext | undefined {
    return this.open?.span.context();
  }

  /** Wall-clock ms the open phase started at. */
  startedAt(): number | undefined {
    return this.open?.since;
  }

  /** Attributes for the phase that is open now. */
  annotate(attrs: Parameters<SpanHandle["setAttrs"]>[0]): void {
    this.open?.span.setAttrs(attrs);
  }

  /** A point occurrence in the phase that is open now. */
  event(name: string, attrs?: Parameters<SpanHandle["addEvent"]>[1]): void {
    this.open?.span.addEvent(name, attrs);
  }

  /** What became of one step of the run, in the phase that is open now; when none is, in the next phase to open. */
  step(attrs: Parameters<SpanHandle["addEvent"]>[1]): void {
    if (this.open) this.open.span.addEvent("step", attrs);
    else this.pendingSteps.push(attrs);
  }

  /** An error nothing handled, recorded on the phase it happened in. */
  fail(error: unknown): void {
    this.open?.span.recordError(error);
  }
}
