/* How much content a trace may carry: nothing but structure (off), structure and redacted text (metadata), or message bodies too (full). */

export const CAPTURE_MODES = ["off", "metadata", "full"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export const DEFAULT_CAPTURE_MODE: CaptureMode = "metadata";

const RANK: Record<CaptureMode, number> = { off: 0, metadata: 1, full: 2 };

export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === "string" && (CAPTURE_MODES as readonly string[]).includes(value);
}

/* The mode a run applies: what it asked for (the default when it asked for nothing), never above the server's ceiling. A caller with a token cannot turn full content export on by itself. */
export function capCaptureMode(requested: CaptureMode | undefined, ceiling: CaptureMode): CaptureMode {
  const wanted = requested ?? DEFAULT_CAPTURE_MODE;
  return RANK[wanted] <= RANK[ceiling] ? wanted : ceiling;
}
