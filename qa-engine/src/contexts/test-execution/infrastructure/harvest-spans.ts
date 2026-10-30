/*
 * A harvest of the dumps a suite run left, as a span of its own: `qayaba.dumps.harvest`, a child of the phase (or the tool call) that is
 * open, from when the harvest of that kind began for as long as it took, with the dump files and bytes it was given, how long its worker
 * took to begin and to work, and how it ended. The bridge tells each kind it handled to this observer; the bridge has no telemetry.
 * Total: a fault here is logged by the caller and never changes what the harvest carries over.
 */

import type { SpanHandle, TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import { startRunChildSpan } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import type { DumpHarvest } from "./run-dump-bridge.ts";

export function harvestSpanObserver(telemetry: TelemetryPort): (harvest: DumpHarvest) => void {
  return (harvest) => {
    const span: SpanHandle = startRunChildSpan(
      telemetry,
      "qayaba.dumps.harvest",
      {
        "qayaba.dumps.kind": harvest.kind,
        "qayaba.dumps.namespace": harvest.namespace,
        "qayaba.dumps.count": harvest.dumps,
        "qayaba.dumps.bytes": harvest.bytes,
        "qayaba.dumps.outcome": harvest.outcome,
        ...(harvest.startMs !== undefined && harvest.startMs !== null ? { "qayaba.dumps.start_ms": Math.round(harvest.startMs) } : {}),
        ...(harvest.workMs !== undefined ? { "qayaba.dumps.work_ms": Math.round(harvest.workMs) } : {}),
      },
      { startTime: harvest.startedAt },
    );
    span.end(harvest.startedAt + Math.round(harvest.durationMs));
  };
}
