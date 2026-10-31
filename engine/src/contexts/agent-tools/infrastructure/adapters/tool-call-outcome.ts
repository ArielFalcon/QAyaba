/* How a served tool call ended, as span attributes: the outcome and, for a call the orchestrator declined, the code and whether DEV was busy. Pure; the answers carry no page content and no spec output, and neither do these. */
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import type { AgentBrowserResponse } from "@contexts/test-execution/application/index.ts";
import type { RunSpecResponse } from "@contexts/test-execution/application/index.ts";
import { runSpecFailureKind } from "../../domain/authoring-failure.ts";
import type { FlowFailureFact } from "../../domain/closed-loop.ts";

export function runSpecOutcome(answer: RunSpecResponse): Attrs {
  if (answer.ok) return { "qayaba.tool.outcome": answer.report.status };
  return { "qayaba.tool.outcome": "refused", "qayaba.tool.refusal": answer.code, ...(answer.code === "busy" ? { "qayaba.lease.refused": true } : {}) };
}

/* Why a call that ran and did not pass failed, in the closed vocabulary of the loop's own facts (`RUN_SPEC_FAILURE_KINDS`): read from the facts the orchestrator kept of the call's failing tests (`failures`) and from what the report itself says, never from the agent's account. A call that passed or was declined says nothing here. */
export function runSpecFailureAttrs(answer: RunSpecResponse, failures: readonly FlowFailureFact[] | undefined): Attrs {
  if (!answer.ok || answer.report.status === "passed") return {};
  const { report } = answer;
  return { "qayaba.tool.failure_kind": runSpecFailureKind({ failures, loadErrors: (report.loadErrors?.length ?? 0) > 0, sessionLost: report.sessionLost === true, timedOut: report.status === "timedOut" }) };
}

export function browserOutcome(answer: AgentBrowserResponse): Attrs {
  if (answer.ok) return { "qayaba.tool.outcome": "ok" };
  return { "qayaba.tool.outcome": "refused", "qayaba.tool.refusal": answer.code, ...(answer.code === "busy" ? { "qayaba.lease.refused": true } : {}) };
}
