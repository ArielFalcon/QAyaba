/* Makes any TelemetryPort total for its callers. The adapters already swallow their own faults; a caller that cannot assume that (a test double, a future adapter) wraps the port here, so a telemetry fault can never change how a run ends. A callback handed to withSpan/withParent always runs, and only the callback's own exception propagates. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { NoopTelemetry } from "./noop-telemetry.ts";
import type { RecordMeasurement, SpanHandle, StartSpanOptions, TelemetryContext, TelemetryPort } from "./telemetry.port.ts";

const NOOP = new NoopTelemetry();
const GUARDED = new WeakSet<object>();

function swallow<T>(fallback: T, op: () => T): T {
  try {
    return op();
  } catch (err) {
    engineLog.error(`[telemetry] a call failed and was dropped: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

class GuardedSpan implements SpanHandle {
  constructor(private readonly inner: SpanHandle) {}
  setAttrs(attrs: Parameters<SpanHandle["setAttrs"]>[0]): void {
    swallow(undefined, () => this.inner.setAttrs(attrs));
  }
  addEvent(name: string, attrs?: Parameters<SpanHandle["addEvent"]>[1], time?: number): void {
    swallow(undefined, () => this.inner.addEvent(name, attrs, time));
  }
  recordError(error: unknown, attrs?: Parameters<SpanHandle["recordError"]>[1], time?: number): void {
    swallow(undefined, () => this.inner.recordError(error, attrs, time));
  }
  end(endTime?: number): void {
    swallow(undefined, () => this.inner.end(endTime));
  }
  context(): TelemetryContext {
    return swallow(NOOP.startSpan("").context(), () => this.inner.context());
  }
  /* The adapter resolves an explicit parent through the handle it made. */
  unwrap(): SpanHandle {
    return this.inner;
  }
}

class GuardedTelemetry implements TelemetryPort {
  constructor(private readonly inner: TelemetryPort) {
    GUARDED.add(this);
  }

  startSpan(name: string, opts?: StartSpanOptions): SpanHandle {
    return swallow<SpanHandle>(NOOP.startSpan(name), () => new GuardedSpan(this.inner.startSpan(name, unwrapOptions(opts))));
  }

  withSpan<T>(name: string, opts: StartSpanOptions, fn: (span: SpanHandle) => T): T {
    const span = this.startSpan(name, opts);
    const ambient = unwrap(span);
    let ran = false;
    const run = (): T => {
      ran = true;
      return fn(span);
    };
    try {
      return this.inner.withParent(ambient, () => settle(span, run()));
    } catch (err) {
      if (ran) {
        span.recordError(err);
        span.end();
        throw err;
      }
      engineLog.error(`[telemetry] withSpan failed before the callback ran: ${err instanceof Error ? err.message : String(err)}`);
      return settle(span, run());
    }
  }

  withParent<T>(parent: SpanHandle | TelemetryContext, fn: () => T): T {
    let ran = false;
    try {
      return this.inner.withParent(unwrap(parent), () => {
        ran = true;
        return fn();
      });
    } catch (err) {
      if (ran) throw err;
      engineLog.error(`[telemetry] withParent failed before the callback ran: ${err instanceof Error ? err.message : String(err)}`);
      return fn();
    }
  }

  activeContext(): TelemetryContext | undefined {
    return swallow<TelemetryContext | undefined>(undefined, () => this.inner.activeContext());
  }

  flush(): void {
    swallow(undefined, () => this.inner.flush());
  }

  counter(name: string): RecordMeasurement {
    const record = swallow<RecordMeasurement>(() => {}, () => this.inner.counter(name));
    return (value, attrs) => swallow(undefined, () => record(value, attrs));
  }

  histogram(name: string): RecordMeasurement {
    const record = swallow<RecordMeasurement>(() => {}, () => this.inner.histogram(name));
    return (value, attrs) => swallow(undefined, () => record(value, attrs));
  }

  gauge(name: string): RecordMeasurement {
    const record = swallow<RecordMeasurement>(() => {}, () => this.inner.gauge(name));
    return (value, attrs) => swallow(undefined, () => record(value, attrs));
  }
}

function unwrap<T extends SpanHandle | TelemetryContext>(parent: T): T | SpanHandle {
  return parent instanceof GuardedSpan ? parent.unwrap() : parent;
}

function unwrapOptions(opts: StartSpanOptions | undefined): StartSpanOptions | undefined {
  return opts?.parent ? { ...opts, parent: unwrap(opts.parent) } : opts;
}

/* Ends the span when the value is a settled result; for a promise, once it settles. */
function settle<T>(span: SpanHandle, result: T): T {
  if (typeof result === "object" && result !== null && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        span.end();
        return value;
      },
      (error: unknown) => {
        span.recordError(error);
        span.end();
        throw error;
      },
    ) as T;
  }
  span.end();
  return result;
}

/* The port made total. Guarding a guarded port returns it unchanged. */
export function guardTelemetry(port: TelemetryPort): TelemetryPort {
  return GUARDED.has(port) ? port : new GuardedTelemetry(port);
}

/* A port whose every method throws: the test double for "telemetry is broken", and proof that the guard is what keeps a run safe. */
export class ThrowingTelemetry implements TelemetryPort {
  private fail(): never {
    throw new Error("telemetry exploded");
  }
  startSpan(): SpanHandle {
    return this.fail();
  }
  withSpan<T>(): T {
    return this.fail();
  }
  withParent<T>(): T {
    return this.fail();
  }
  activeContext(): TelemetryContext | undefined {
    return this.fail();
  }
  flush(): void {
    this.fail();
  }
  counter(): RecordMeasurement {
    return this.fail();
  }
  histogram(): RecordMeasurement {
    return this.fail();
  }
  gauge(): RecordMeasurement {
    return this.fail();
  }
}
