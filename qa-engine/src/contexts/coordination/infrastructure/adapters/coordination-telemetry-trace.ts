/*
 * The coordination ledger as spans: every decision of a coordinated run (the plan, each flow's turn and whether its files were taken back,
 * the lead's review and what it refused, a correction's routing) is also a `qayaba.coordination.event` span of the phase that is open, so the
 * trace of a run says why each flow ended as it did. A decorator: the ledger records what it always recorded.
 */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";
import type { CoordinationTelemetryEvent, CoordinationTelemetryPort } from "../../application/coordination-telemetry.ts";

/* The most items of a list an event exports; the registry caps the array again. */
const MAX_LISTED = 12;

export class TracedCoordinationTelemetry implements CoordinationTelemetryPort {
  constructor(
    private readonly inner: CoordinationTelemetryPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  record(event: CoordinationTelemetryEvent): void {
    this.inner.record(event);
    startRunChildSpan(this.telemetry, "qayaba.coordination.event", {
      "qayaba.coordination.kind": event.kind,
      ...(event.action ? { "qayaba.coordination.action": event.action } : {}),
      "qayaba.coordination.reason": sanitizeText(event.reason).text,
      ...(event.delegationId ? { "qayaba.delegation.id": event.delegationId } : {}),
      ...(event.attempt !== undefined ? { "qayaba.coordination.attempt": event.attempt } : {}),
      ...(event.failureClass ? { "qayaba.coordination.failure_class": event.failureClass } : {}),
      ...(event.sidekickStatus ? { "qayaba.delegation.status": event.sidekickStatus } : {}),
      ...(event.lastRunSpec ? { "qayaba.delegation.last_run_spec": event.lastRunSpec } : {}),
      ...(event.flowId ? { "qayaba.coordination.flow_id": event.flowId } : {}),
      ...(event.candidateIds && event.candidateIds.length > 0 ? { "qayaba.coordination.candidate_ids": event.candidateIds.slice(0, MAX_LISTED) } : {}),
      ...(event.origin ? { "qayaba.coordination.origin": event.origin } : {}),
      ...(event.findings !== undefined ? { "qayaba.coordination.findings": event.findings } : {}),
      ...(event.routes ? {
        "qayaba.coordination.findings_by_spec": event.routes.spec,
        "qayaba.coordination.findings_by_candidate": event.routes.candidate,
        "qayaba.coordination.findings_by_lead": event.routes.lead,
        "qayaba.coordination.findings_by_candidate_flow": event.routes.candidateFlow,
        "qayaba.coordination.findings_unrouted": event.routes.unrouted,
      } : {}),
      ...(event.unroutedReasons && event.unroutedReasons.length > 0 ? { "qayaba.coordination.unrouted_reasons": event.unroutedReasons.slice(0, MAX_LISTED) } : {}),
      ...(event.dropBases && event.dropBases.length > 0 ? { "qayaba.coordination.drop_bases": event.dropBases.slice(0, MAX_LISTED) } : {}),
      ...(event.dropContradicted !== undefined ? { "qayaba.coordination.drop_contradicted": event.dropContradicted } : {}),
      ...(event.capacity !== undefined ? { "qayaba.coordination.capacity": event.capacity } : {}),
      ...(event.notAdmitted && event.notAdmitted.length > 0 ? { "qayaba.coordination.flows_not_admitted": event.notAdmitted.slice(0, MAX_LISTED) } : {}),
      ...(event.oversize && event.oversize.length > 0 ? { "qayaba.coordination.flows_oversize": event.oversize.slice(0, MAX_LISTED) } : {}),
      ...(event.decision ? { "qayaba.coordination.decision": event.decision } : {}),
      ...(event.overridden !== undefined ? { "qayaba.coordination.decision_overridden": event.overridden } : {}),
      ...(event.overrideReason ? { "qayaba.coordination.override_reason": event.overrideReason } : {}),
    }).end();
  }
}
