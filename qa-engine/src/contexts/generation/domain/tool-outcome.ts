/*
 * How one tool call ended, derived once from the runtime's part and read by every record of the call (its span, its
 * sequence entry, its run event). A message is redacted text the runtime attached to the ending; nothing decides from it.
 */
/** How the runtime stated a call stood at its latest sighting. */
export type ToolStatus = "running" | "completed" | "error";

export type ToolOutcome =
  | { kind: "completed" }
  | { kind: "running" }
  | { kind: "failed"; message?: string }
  | { kind: "denied"; message?: string }
  | { kind: "invalid"; attempted?: string; message?: string };

/** What a runtime's adapter reads off a tool part: how the runtime stated the call ended, whether a permission rule refused it, and the repair it made of a malformed one. */
export interface ToolCallReading {
  status: ToolStatus;
  refusedByRule: boolean;
  repaired?: { attempted?: string; message?: string };
  message?: string;
}

/** The runtime's redacted message on a call that did not complete, when it gave one. */
export const toolOutcomeMessage = (outcome: ToolOutcome): string | undefined => (outcome.kind === "completed" || outcome.kind === "running" ? undefined : outcome.message);

const present = <T extends object>(fields: T): T => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

export function toolOutcome(reading: ToolCallReading): ToolOutcome {
  if (reading.status === "running") return { kind: "running" };
  if (reading.repaired) return { kind: "invalid", ...present(reading.repaired) };
  if (reading.status === "completed") return { kind: "completed" };
  return { kind: reading.refusedByRule ? "denied" : "failed", ...present({ message: reading.message }) };
}

const SPAN_STATUS = {
  completed: "completed",
  running: "running",
  failed: "error",
  denied: "denied",
  invalid: "error",
} as const satisfies Record<ToolOutcome["kind"], ToolStatus | "denied">;

/** The status a span states for a call: how it ended, with a refusal and a repaired call told apart from the runtime's own word. */
export function toolOutcomeStatus(outcome: ToolOutcome): ToolStatus | "denied" {
  return SPAN_STATUS[outcome.kind];
}
