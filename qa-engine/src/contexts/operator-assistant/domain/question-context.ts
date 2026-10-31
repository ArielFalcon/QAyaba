/*
 * What the assistant's prompt is made of beyond the run or product context: the operator's question, cut after its credentials are taken
 * out, the recent conversation, and the instruction the product-help assistant answers under. The operator's words go to a model: a
 * credential pasted into them leaves before anything is cut (kernel redact-then-bound).
 */
import { redactThenBound } from "@kernel/redact-then-bound.ts";

/* Truncate to prevent context window exhaustion. */
export const MAX_QUESTION_CHARS = 4000;

export const boundQuestion = (question: string, redact: (text: string) => string): string => redactThenBound(question, MAX_QUESTION_CHARS, redact, { marker: () => " [truncated]" });

/* How many of the latest conversation lines each assistant is given. */
const RUN_CHAT_HISTORY_LINES = 6;
const HELP_CHAT_HISTORY_LINES = 10;

/* One line of the conversation so far, before redaction: `q` is the operator, anything else the assistant. */
export const runHistoryLine = (entry: { readonly role: unknown; readonly text: unknown }): string => `${entry.role === "q" ? "Operator" : "Assistant"}: ${String(entry.text)}`;

export const helpHistoryLine = (entry: { readonly role: unknown; readonly text: unknown }): string => `${String(entry.role)}: ${String(entry.text)}`;

/* The context of a question about one run: how to read the chat, the run itself, and the latest lines of the conversation. */
export function runQuestionContext(parts: { readonly orientation: string; readonly run: string; readonly history: readonly string[] }): string {
  const history = parts.history.length > 0 ? `\n\nRecent conversation:\n${parts.history.slice(-RUN_CHAT_HISTORY_LINES).join("\n")}` : "";
  return `${parts.orientation}\n\n---\n\n${parts.run}${history}`;
}

/* The context of a product question: the product text and the latest lines of the conversation. */
export function helpQuestionContext(help: string, history: readonly string[]): string {
  return history.length > 0 ? `${help}\n\n## Recent conversation\n${history.slice(-HELP_CHAT_HISTORY_LINES).join("\n")}` : help;
}

export const HELP_INSTRUCTION =
  "You are a helpful assistant answering questions about qayaba (the TUI for qayaba). " +
  "Use ONLY the context below. " +
  "TERMINAL-FRIENDLY FORMATTING (this renders in a TUI via Ink <Text>): " +
  "allowed: blank lines, indentation, capitalized headers (RESUMEN, USO), " +
  "plain text lists with '-', '───' separators between topics. " +
  "forbidden: **bold**, `code`, # headings, code fences, emojis, HTML. " +
  "Respond in the SAME language as the question. Be concise. " +
  "If the context lacks the answer, say so and suggest what to ask instead.";
