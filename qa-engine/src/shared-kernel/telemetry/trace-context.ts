/* The W3C `traceparent` header of a span, for a hop that cannot share the process's trace context (an HTTP call to another container, the environment of a child). Pure. */
import type { TelemetryContext } from "./telemetry.port.ts";

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZEROS = /^0+$/;

/* `00-<trace id>-<span id>-01`, or undefined when the context is not a real span (a disabled or failed telemetry hands out zeros): a header that names no span would only fork a trace of its own. The sampled flag is set: the context carries none, and a span the orchestrator did not sample is simply never joined by a backend. */
export function traceparentOf(context: TelemetryContext): string | undefined {
  const { traceId, spanId } = context;
  if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId) || ZEROS.test(traceId) || ZEROS.test(spanId)) return undefined;
  return `00-${traceId}-${spanId}-01`;
}
