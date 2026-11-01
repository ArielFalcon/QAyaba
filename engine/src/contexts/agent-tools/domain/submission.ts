/*
 * What an agent's submit tool asks of the orchestrator and what it is told. The call carries the session and agent the runtime
 * reports, the tool, and the answer the model typed; the contract armed for the session's prompt judges the answer, and the
 * model reads the errors it returns (a path and a reason each) inside the same turn.
 */

import type { SubmissionError } from "@kernel/submission.ts";

export interface SubmitRequest {
  sessionId: string;
  agent: string;
  /* The OpenCode message id, reported for the trace's sake alone. */
  messageId?: string;
  tool: string;
  answer: unknown;
}

export type SubmitRefusalCode = "wrong-agent" | "wrong-tool" | "already-submitted" | "invalid-answer";

export type SubmitResponse =
  | { ok: true; message: string }
  | { ok: false; code: SubmitRefusalCode; message: string; errors?: SubmissionError[] };

export const MAX_ERRORS_RETURNED = 20;
export const MAX_ERROR_PATH_CHARS = 120;
export const MAX_ERROR_REASON_CHARS = 300;
