/* The null object: the telemetry port when telemetry is off or the shell supplied none. Costs one call and records nothing. */

import type { RecordMeasurement, SpanHandle, StartSpanOptions, TelemetryContext, TelemetryPort } from "./telemetry.port.ts";

const NO_CONTEXT: TelemetryContext = Object.freeze({ traceId: "00000000000000000000000000000000", spanId: "0000000000000000" });

const NOOP_SPAN: SpanHandle = Object.freeze({
  setAttrs: () => {},
  addEvent: () => {},
  recordError: () => {},
  end: () => {},
  context: () => NO_CONTEXT,
});

const NOOP_RECORD: RecordMeasurement = () => {};

export class NoopTelemetry implements TelemetryPort {
  startSpan(_name?: string, _opts?: StartSpanOptions): SpanHandle {
    return NOOP_SPAN;
  }
  withSpan<T>(_name: string, _opts: StartSpanOptions, fn: (span: SpanHandle) => T): T {
    return fn(NOOP_SPAN);
  }
  withParent<T>(_parent: SpanHandle | TelemetryContext, fn: () => T): T {
    return fn();
  }
  activeContext(): undefined {
    return undefined;
  }
  flush(): void {}
  counter(_name?: string): RecordMeasurement {
    return NOOP_RECORD;
  }
  histogram(_name?: string): RecordMeasurement {
    return NOOP_RECORD;
  }
  gauge(_name?: string): RecordMeasurement {
    return NOOP_RECORD;
  }
}
