/* Test support: the real OtelTelemetry adapter over an in-memory exporter, a fake clock and a recording meter, plus a tracker of started and ended spans so a test can tell a span that never ended (an InMemorySpanExporter only sees finished ones). Lives under src/telemetry/ because it imports the SDK. */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { SpanStatusCode, type Meter } from "@opentelemetry/api";

/* Re-exported so a test outside src/telemetry/ needs no SDK import of its own. */
export { SpanStatusCode };
import { OtelTelemetry, type CaptureMode } from "./otel-telemetry.adapter";
import type { TelemetryClock } from "@kernel/telemetry/telemetry.port";

export const T0 = 1_760_000_000_000;

export class FakeClock implements TelemetryClock {
  constructor(public t = T0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Measurement {
  readonly name: string;
  readonly type: "counter" | "histogram" | "gauge";
  readonly value: number;
  readonly attrs: Record<string, unknown>;
}

function recordingMeter(into: Measurement[]): Meter {
  const instrument = (name: string, type: Measurement["type"]) => {
    const record = (value: number, attrs?: Record<string, unknown>): void => {
      into.push({ name, type, value, attrs: { ...(attrs ?? {}) } });
    };
    return type === "counter" ? { add: record } : { record };
  };
  return {
    createCounter: (name: string) => instrument(name, "counter"),
    createHistogram: (name: string) => instrument(name, "histogram"),
    createGauge: (name: string) => instrument(name, "gauge"),
  } as unknown as Meter;
}

class LifecycleTracker implements SpanProcessor {
  readonly started = new Map<string, Span>();
  readonly ended = new Set<string>();
  onStart(span: Span): void {
    this.started.set(span.spanContext().spanId, span);
  }
  onEnd(span: ReadableSpan): void {
    this.ended.add(span.spanContext().spanId);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function traceHarness(opts: { captureMode?: CaptureMode; clock?: FakeClock } = {}) {
  const exporter = new InMemorySpanExporter();
  const tracker = new LifecycleTracker();
  const provider = new BasicTracerProvider({ spanProcessors: [tracker, new SimpleSpanProcessor(exporter)] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const clock = opts.clock ?? new FakeClock();
  const measurements: Measurement[] = [];
  let flushes = 0;
  const telemetry = new OtelTelemetry({
    tracer: provider.getTracer("t"),
    contextManager,
    clock,
    ...(opts.captureMode ? { captureMode: opts.captureMode } : {}),
    meter: recordingMeter(measurements),
    flush: () => {
      flushes += 1;
    },
  });
  const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
  return {
    telemetry,
    clock,
    exporter,
    measurements,
    flushCount: () => flushes,
    spans,
    named: (name: string): ReadableSpan[] => spans().filter((s) => s.name === name),
    only: (name: string): ReadableSpan => {
      const found = spans().filter((s) => s.name === name);
      if (found.length !== 1) throw new Error(`expected one span named ${name}, found ${found.length}`);
      return found[0]!;
    },
    /* Spans that started and never ended. */
    unended: (): string[] => [...tracker.started.values()].filter((s) => !tracker.ended.has(s.spanContext().spanId)).map((s) => s.name),
    /* Spans whose parent is not itself a span of this harness: the trace tree has no orphan. */
    orphans: (): string[] => {
      const ids = new Set([...tracker.started.keys()]);
      return spans()
        .filter((s) => s.parentSpanContext !== undefined && !ids.has(s.parentSpanContext.spanId))
        .map((s) => s.name);
    },
    dispose: async (): Promise<void> => {
      await provider.shutdown();
    },
  };
}
