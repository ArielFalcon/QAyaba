/*
 * The one place the OpenCode runtime's words about a tool call are read: its error text, the wording of a permission
 * refusal and the repair pseudo-tool named `invalid`. Everything else reads the derived `ToolOutcome`.
 */
import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { redactThenBound } from "../../../../shared-kernel/redact-then-bound.ts";
import { toolOutcome, type ToolOutcome, type ToolStatus } from "../../domain/tool-outcome.ts";
import { TOOL_TARGET_MAX_CHARS } from "../../domain/tool-sequence.ts";

/** The longest error message one call keeps, after redaction. */
export const TOOL_ERROR_MAX_CHARS = 1_000;

/* The message the runtime attaches to a call a permission rule refuses (the pinned build's own wording). A rejection by a person, or any other failure of a tool, is not this. */
const DENIAL_MESSAGE = /specified a rule which prevents you from using this specific tool call/i;

/* The tool the runtime substitutes for a call whose arguments it could not use; its input names the attempted tool and the message. */
const REPAIR_TOOL = "invalid";

/** The part of a tool part this module reads. */
export interface OpencodeToolPart {
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
}

/** The collaborator that redacts the text a call carries. */
export interface ToolOutcomeDeps {
  redact: (text: string) => string;
}

export const defaultToolOutcomeDeps: ToolOutcomeDeps = { redact: (text) => sanitizeText(text).text };

/** Text from the agent's workspace, redacted like every text that leaves the system, then capped (the one rule: redact-then-bound.ts): a cut never leaves part of a credential. A fault in redaction yields a marker, never the raw text. */
export function redactedText(raw: string, maxChars: number, deps: ToolOutcomeDeps = defaultToolOutcomeDeps): string {
  return redactThenBound(raw, maxChars, deps.redact);
}

const messageOf = (raw: unknown, deps: ToolOutcomeDeps): string | undefined =>
  typeof raw === "string" && raw !== "" ? redactedText(raw, TOOL_ERROR_MAX_CHARS, deps) : undefined;

function statusOf(raw: string | undefined): ToolStatus {
  return raw === "running" || raw === "error" ? raw : "completed";
}

/** How the call ended, from the part's latest sighting. */
export function toolOutcomeOf(part: OpencodeToolPart, deps: ToolOutcomeDeps = defaultToolOutcomeDeps): ToolOutcome {
  const state = part.state;
  const status = statusOf(state?.status);
  if (part.tool === REPAIR_TOOL) {
    const input = typeof state?.input === "object" && state.input !== null ? (state.input as Record<string, unknown>) : {};
    const attempted = typeof input.tool === "string" && input.tool !== "" ? redactedText(input.tool, TOOL_TARGET_MAX_CHARS, deps) : undefined;
    const message = messageOf(input.error, deps);
    return toolOutcome({ status, refusedByRule: false, repaired: { ...(attempted !== undefined ? { attempted } : {}), ...(message !== undefined ? { message } : {}) } });
  }
  const refusedByRule = status === "error" && typeof state?.error === "string" && DENIAL_MESSAGE.test(state.error);
  return toolOutcome({ status, refusedByRule, message: status === "error" ? messageOf(state?.error, deps) : undefined });
}

/** What a finished call answered the agent with: its output when it completed, its error text when it failed. */
export function toolAnswerOf(part: OpencodeToolPart): unknown {
  return part.state?.status === "completed" ? part.state.output : part.state?.error;
}
