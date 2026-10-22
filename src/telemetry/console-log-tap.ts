/* Mirrors console output into OTel logs while a span is active, so the orchestrator's existing console lines reach Loki
   without a logger abstraction. The mirror is the console itself: stdout and the rotating JSON file are unchanged.

   Rules:
   - No active span, no record. Startup, health polling and the queue's idle paths stay in docker.
   - The span's capture mode decides: `off` exports nothing, `metadata` keeps a diagnostic line, `full` keeps more. The
     body is redacted through the run's scope (by value) and the outbound sanitizer, then capped. A failed redaction
     drops the record: the raw line is never exported.
   - The record inherits the active span's trace and span ids, so Loki can join it to the run's trace.
   - A fault in the tap or the logger never breaks the caller or prints twice. */

import { format } from "node:util";
import type { Context } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { TEXT_CAP_CHARS, type CaptureMode } from "./otel-telemetry.adapter";

/* The body cap follows the capture mode. Metadata gets the same cap as any redacted-text attribute; full keeps a
   console line useful without making Loki a log store for arbitrary process output. */
export const LOG_BODY_CAP_CHARS: Record<CaptureMode, number> = {
  off: 0,
  metadata: TEXT_CAP_CHARS,
  full: 4 * TEXT_CAP_CHARS,
};

export interface ConsoleLogTapDeps {
  readonly logger: Pick<Logger, "emit">;
  /* The active span's capture mode and context, or undefined when no span is active. */
  readonly activeSpan: () => { readonly mode: CaptureMode; readonly context: Context } | undefined;
  /* Redact and cap a line through the active span's scope. undefined means: do not export. */
  readonly redact: (text: string, cap: number) => string | undefined;
  /* Default: node:util.format. */
  readonly format?: (...args: unknown[]) => string;
}

const LEVELS = {
  log: { severityNumber: SeverityNumber.INFO, severityText: "INFO" },
  warn: { severityNumber: SeverityNumber.WARN, severityText: "WARN" },
  error: { severityNumber: SeverityNumber.ERROR, severityText: "ERROR" },
} as const;

type Level = keyof typeof LEVELS;

export function installConsoleLogTap(deps: ConsoleLogTapDeps): () => void {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const formatLine = deps.format ?? ((...args: unknown[]) => format(...args));
  let emitting = false;

  const emit = (level: Level, args: unknown[]): void => {
    try {
      if (emitting) return;
      const span = deps.activeSpan();
      if (span === undefined || span.mode === "off") return;
      const body = deps.redact(formatLine(...args), LOG_BODY_CAP_CHARS[span.mode]);
      if (body === undefined) return;
      emitting = true;
      try {
        deps.logger.emit({ severityNumber: LEVELS[level].severityNumber, severityText: LEVELS[level].severityText, body, timestamp: new Date(), context: span.context });
      } finally {
        emitting = false;
      }
    } catch {
      /* A console line never breaks the caller and is never exported half-redacted. */
    }
  };

  for (const level of Object.keys(LEVELS) as Level[]) {
    console[level] = (...args: unknown[]): void => {
      original[level](...args);
      emit(level, args);
    };
  }

  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}
