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
  readonly scoreSink: { readonly configured: boolean };
  /* Attributes dropped by the registry or the capture policy. */
  readonly droppedAttributes: number;
}
