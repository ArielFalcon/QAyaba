/* The engine's view of tracing and metrics. No SDK types cross this port: the OpenTelemetry SDK lives only in src/telemetry/ (rule `no-telemetry-sdk-in-engine`). Every method is total: an adapter fault is counted in its health and swallowed, never thrown into a run. */

import type { Attrs } from "./attribute-registry.ts";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/* Wall-clock milliseconds, injected so a span's times and a synthesized child's times come from one clock (the SDK's own end-time delta is monotonic and stops while a VM is suspended) and so tests need no real time. */
export interface TelemetryClock {
  now(): number;
}

/* Redacts the run's own secrets, by value, from text. Passed by the caller at span creation so redaction does not depend on whichever async context happens to be active when an attribute is set. */
export interface RedactionScope {
  redact(text: string): string;
}

/* A position in a trace: enough to parent a span or link to one. */
export interface TelemetryContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface SpanLink {
  readonly context: TelemetryContext;
  readonly attrs?: Attrs;
}

export interface StartSpanOptions {
  readonly kind?: SpanKind;
  readonly attrs?: Attrs;
  readonly links?: readonly SpanLink[];
  /* Wall-clock ms. Defaults to the adapter's clock. */
  readonly startTime?: number;
  /* The explicit parent. Without one the span is a child of the active context. */
  readonly parent?: SpanHandle | TelemetryContext;
  /* Start a new trace, ignoring the active context (the run root, which must not become a child of the request that enqueued it). */
  readonly root?: boolean;
  /* The scope the span's text attributes, events and errors are redacted through. Inherited from an explicit parent handle when absent. */
  readonly secrets?: RedactionScope;
}

export interface SpanHandle {
  setAttrs(attrs: Attrs): void;
  addEvent(name: string, attrs?: Attrs, time?: number): void;
  /* Records an exception event and marks the span ERROR. Only for infrastructure failures; a product outcome is an attribute. */
  recordError(error: unknown, attrs?: Attrs): void;
  /* Wall-clock ms. Defaults to the adapter's clock. Ending twice is a no-op. */
  end(endTime?: number): void;
  context(): TelemetryContext;
}

/* Records one measurement. Only attribute keys the instrument declares are kept. */
export type RecordMeasurement = (value: number, attrs?: Attrs) => void;

export interface TelemetryPort {
  startSpan(name: string, opts?: StartSpanOptions): SpanHandle;
  /* Runs `fn` with the span active and always ends it, on return, on throw and, for a promise, on settlement. The callback's own exception is rethrown after being recorded. */
  withSpan<T>(name: string, opts: StartSpanOptions, fn: (span: SpanHandle) => T): T;
  /* Runs `fn` under an explicit parent, for where the ambient context is a restored snapshot or a stream callback. */
  withParent<T>(parent: SpanHandle | TelemetryContext, fn: () => T): T;
  activeContext(): TelemetryContext | undefined;
  /* Instruments are declared in instrument-table.ts; an undeclared name records nothing. */
  /* Commits any buffered local records now (the run calls it on a phase change so a hung run is visible while it hangs). */
  flush(): void;
  counter(name: string): RecordMeasurement;
  histogram(name: string): RecordMeasurement;
}
