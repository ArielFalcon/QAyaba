/*
 * The coordination ledger as spans: every decision of a coordinated run (the plan, each flow's turn and whether its files were taken back,
 * the lead's review and what it refused, a correction's routing) is also a `qayaba.coordination.event` span of the phase that is open, so the
 * trace of a run says why each flow ended as it did. A decorator: the ledger records what it always recorded.
 */

import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";
import type { CoordinationTelemetryEvent, CoordinationTelemetryPort } from "../../application/coordination/coordination-telemetry.ts";

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
    }).end();
  }
}
