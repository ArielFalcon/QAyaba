/*
 * The slice of a span of the run's ledger that evidence reads, and the three readers of its JSON attributes every derivation
 * shares. An attribute that is missing or of another type reads as absent, never as a guessed value.
 */

export interface LedgerSpan {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  /* The span's attributes as JSON. */
  attrs: string;
}

export function attrsOf(s: LedgerSpan): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s.attrs);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export const optStr = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
