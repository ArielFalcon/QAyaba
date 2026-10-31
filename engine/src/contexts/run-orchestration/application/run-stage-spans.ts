/*
 * The stretches of a run that are not a phase (RUN_STAGES) as spans: `qayaba.stage.<name>`, a child of the run's root. The
 * span is the active context while the work runs, so a child the work starts (a nested run's link, an exec) hangs under it, and it
 * ends on return, on throw and on a promise's settlement; a throw marks it an error and goes on to the caller unchanged.
 *
 * Observability never changes how a run ends: the port is total (guardTelemetry), so a telemetry fault costs the span, never the work.
 */
import { stageSpanName, type RunStage } from "@kernel/run-step.ts";
import type { RedactionScope, SpanHandle, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";

export function traceStage<T>(telemetry: TelemetryPort, stage: RunStage, fn: () => T, opts: { parent?: SpanHandle; secrets?: RedactionScope } = {}): T {
  return telemetry.withSpan(stageSpanName(stage), { kind: "internal", ...(opts.parent ? { parent: opts.parent } : {}), ...(opts.secrets ? { secrets: opts.secrets } : {}) }, () => fn());
}
