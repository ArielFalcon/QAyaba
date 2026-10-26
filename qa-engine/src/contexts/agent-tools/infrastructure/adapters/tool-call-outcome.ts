/* How a served tool call ended, as span attributes: the outcome and, for a call the orchestrator declined, the code and whether DEV was busy. Pure; the answers carry no page content and no spec output, and neither do these. */
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import type { AgentBrowserResponse } from "@contexts/test-execution/application/index.ts";
import type { RunSpecResponse } from "@contexts/test-execution/application/index.ts";

export function runSpecOutcome(answer: RunSpecResponse): Attrs {
  if (answer.ok) return { "qayaba.tool.outcome": answer.report.status };
  return { "qayaba.tool.outcome": "refused", "qayaba.tool.refusal": answer.code, ...(answer.code === "busy" ? { "qayaba.lease.refused": true } : {}) };
}

export function browserOutcome(answer: AgentBrowserResponse): Attrs {
  if (answer.ok) return { "qayaba.tool.outcome": "ok" };
  return { "qayaba.tool.outcome": "refused", "qayaba.tool.refusal": answer.code, ...(answer.code === "busy" ? { "qayaba.lease.refused": true } : {}) };
}
