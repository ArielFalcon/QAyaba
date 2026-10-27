/* Turns a line the logging port already redacted and chose to ship into an OTel log record for Loki.

   Tempo holds what happened (structured spans); Loki holds how it happened: the lines that explain a degraded capture, a
   fallback, an unexpected input, a warning. Which lines are shipped is decided at the call site and by level (see
   `shipsToStore` in redacting-logger.ts); this module only places and bounds them.

   Rules:
   - The record joins the ambient span's trace, else the run root that is open (`OtelTelemetry.logTarget`), so a line
     written in a phase, a stream callback or a timer still carries the run's trace id. A line with no run is a process
     line (a warning at boot) and carries no trace.
   - The capture mode decides: `off` ships nothing, `metadata` keeps the line, `full` keeps more. The body is redacted
     again through the run's scope (by value) and the outbound sanitizer, then capped. A failed redaction drops the
     record: the raw line is never exported.
   - A fault here never reaches the caller. */

import type { Context } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import type { LogLevel } from "../integrations/logger";
import type { LogShipper } from "../integrations/redacting-logger";
import { TEXT_CAP_CHARS, type CaptureMode } from "./otel-telemetry.adapter";

/* The body cap follows the capture mode: a line that explains how something went is short; full keeps more of its fields. */
export const LOG_BODY_CAP_CHARS: Record<CaptureMode, number> = {
  off: 0,
  metadata: TEXT_CAP_CHARS,
  full: 4 * TEXT_CAP_CHARS,
};

export interface LogShipperDeps {
  readonly logger: Pick<Logger, "emit">;
  /* Where the line belongs, or undefined when it belongs to no run. */
  readonly target: () => { readonly mode: CaptureMode; readonly context: Context } | undefined;
  /* The mode of a line that belongs to no run. */
  readonly processMode: () => CaptureMode;
  /* Redact and cap through the target's run scope. undefined means: do not export. */
  readonly redact: (context: Context | undefined, text: string, cap: number) => string | undefined;
}

const SEVERITY: Record<LogLevel, { readonly number: SeverityNumber; readonly text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
};

export function createLogShipper(deps: LogShipperDeps): LogShipper {
  return ({ level, message, fields }) => {
    try {
      const target = deps.target();
      const mode = target?.mode ?? deps.processMode();
      if (mode === "off") return;
      const text = Object.keys(fields).length === 0 ? message : `${message} ${JSON.stringify(fields)}`;
      const body = deps.redact(target?.context, text, LOG_BODY_CAP_CHARS[mode]);
      if (body === undefined) return;
      deps.logger.emit({
        severityNumber: SEVERITY[level].number,
        severityText: SEVERITY[level].text,
        body,
        timestamp: new Date(),
        ...(target ? { context: target.context } : {}),
      });
    } catch {
      /* A log line never breaks the caller and is never exported half-redacted. */
    }
  };
}
