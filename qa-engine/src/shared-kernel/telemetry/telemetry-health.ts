/* What `GET /api/v1/telemetry/health` reports about the telemetry stack. Counts and flags only: no endpoint, key or error text that could carry a secret. */

export type TelemetryModeName = "off" | "local";

export interface TelemetryHealth {
  readonly mode: TelemetryModeName;
  readonly campaignFreeze: boolean;
  readonly otlp: {
    readonly configured: boolean;
    /* ISO-8601 time of the last successful export. */
    readonly lastExportAt?: string;
    /* A short, sanitized description of the last failed export. */
    readonly lastError?: string;
    /* Spans lost to failed exports. */
    readonly dropped: number;
  };
  readonly ledger: {
    readonly ok: boolean;
    /* Rows committed to the span ledger. */
    readonly spans: number;
    readonly writeErrors: number;
  };
  /* The Langfuse score mirror: configured only when the address and both keys are set. Scores are stored locally first, so a fault here changes no grade. */
  readonly scoreSink: {
    readonly configured: boolean;
    /* Scores that failed or were held back (score configs not ensured); absent until there is one. */
    readonly faults?: number;
    /* ISO-8601 time of the last score accepted by Langfuse. */
    readonly lastExportAt?: string;
    /* A short, sanitized description of the last failure; never a key. */
    readonly lastError?: string;
  };
  /* Attributes dropped by the registry or the capture policy. */
  readonly droppedAttributes: number;
}
