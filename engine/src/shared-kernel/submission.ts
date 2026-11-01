/** The submit tool of each contract an agent role delivers. A tool is named by what it submits. */
export const SUBMIT_TOOL = {
  PLAN: "submit_plan",
  FLOW_REVIEW: "submit_flow_review",
  CORRECTIONS: "submit_corrections",
  RESULT: "submit_result",
  SPECS: "submit_specs",
  REVIEW: "submit_review",
  PROFILES: "submit_profiles",
} as const;
export type SubmitTool = (typeof SUBMIT_TOOL)[keyof typeof SUBMIT_TOOL];
export const SUBMIT_TOOLS: readonly SubmitTool[] = Object.values(SUBMIT_TOOL);

/** One reason a submission is not the contract's: where in the answer, and why. */
export interface SubmissionError {
  readonly path: string;
  readonly reason: string;
}

export type SubmissionCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly SubmissionError[] };

/** What one turn must deliver: the tool it calls and the owning context's judgment of what the call carried. */
export interface SubmissionContract<T> {
  readonly tool: SubmitTool;
  check(answer: unknown): SubmissionCheck<T>;
}

/** How a turn ended without an accepted submission: it stopped on its own, or the model's output-length limit cut it. */
export type SubmissionEnd = "stopped" | "output-length";

export type SubmissionReport =
  | { readonly accepted: true; readonly value: unknown; readonly calls: number }
  | { readonly accepted: false; readonly calls: number; readonly errors: readonly SubmissionError[]; readonly end: SubmissionEnd };

/** The orchestrator's side of one armed prompt, held between the prompt's start and its end. */
export interface SubmissionSlot {
  report(end: SubmissionEnd): SubmissionReport;
  close(): void;
}

export interface SubmissionPort {
  /** Opens the session to one contract's submit tool for the prompt that follows; the slot closes when the prompt ends. */
  arm(sessionId: string, agent: string, contract: SubmissionContract<unknown>): SubmissionSlot;
}

export interface NoSubmission {
  readonly end: SubmissionEnd;
  /** The last rejection's errors; empty when no call was made. */
  readonly errors: readonly SubmissionError[];
  readonly calls: number;
  readonly continued: boolean;
  /** The continuation ran out of the time its purpose was allotted. */
  readonly continuationTimedOut: boolean;
}

export type SubmittedTurn<T> =
  | { readonly submitted: true; readonly value: T; readonly output: string; readonly calls: number; readonly continued: boolean }
  | ({ readonly submitted: false; readonly output: string } & NoSubmission);

const MAX_ERRORS_SHOWN = 12;

export function renderSubmissionErrors(errors: readonly SubmissionError[]): string {
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).map((error) => `${error.path}: ${error.reason}`);
  return (errors.length > MAX_ERRORS_SHOWN ? [...shown, `and ${errors.length - MAX_ERRORS_SHOWN} more`] : shown).join("; ");
}

export function describeNoSubmission(miss: NoSubmission): string {
  const how = miss.end === "output-length" ? "its output hit the model's length limit" : "it stopped";
  const asked = miss.continued ? (miss.continuationTimedOut ? "the continuation ran out of its time" : "the continuation did not deliver either") : "no continuation was asked";
  const last = miss.errors.length > 0 ? `; the last rejection: ${renderSubmissionErrors(miss.errors)}` : "";
  return `no accepted submission (${how}; ${miss.calls} call${miss.calls === 1 ? "" : "s"}; ${asked})${last}`;
}

export function submissionContinuationPrompt(tool: SubmitTool, miss: Pick<NoSubmission, "end" | "errors">): string {
  const how = miss.end === "output-length" ? "was cut by the model's output-length limit" : "ended";
  const rejected = miss.errors.length > 0 ? ` Your last ${tool} call was rejected: ${renderSubmissionErrors(miss.errors)}.` : "";
  return `Your previous turn ${how} without an accepted ${tool} call, so nothing you wrote was read.${rejected} Call ${tool} now with your complete answer. It is the only tool available and the only way to answer.`;
}
