/*
 * How a run ends that never reaches its own verdict: an operator cancelled it, or the process that ran it ended under it. It is
 * `infra-error` (the run reached no verdict, which is not a defect of the code under test), with a note that says how it was left. An
 * operator's cancel is recorded as such, so grading says "cancelled" and nothing else about a run that never ran its pipeline.
 */
import type { RunVerdict } from "@kernel/run-verdict.ts";

export type UnfinishedRunCause =
  /* The queue held the run and aborted its in-flight turn. */
  | "cancelled-live"
  /* The run was still waiting in the queue. */
  | "cancelled-enqueued"
  /* The record said running, but the queue no longer held it (a zombie left by a restart, or a view that lagged the queue). */
  | "cancelled-inactive"
  /* A previous process left the run enqueued or running. */
  | "interrupted";

export interface UnfinishedRunEnding {
  readonly verdict: Extract<RunVerdict, "infra-error">;
  readonly note: string;
  readonly cancelled: boolean;
}

const NOTES: Readonly<Record<UnfinishedRunCause, string>> = {
  "cancelled-live": "cancelled by operator",
  "cancelled-enqueued": "cancelled by operator",
  "cancelled-inactive": "cancelled by operator (run was no longer active)",
  interrupted: "process restarted — run was interrupted",
};

export function unfinishedRunEnding(cause: UnfinishedRunCause): UnfinishedRunEnding {
  return { verdict: "infra-error", note: NOTES[cause], cancelled: cause !== "interrupted" };
}

/* A cancel finalizes a record that is still running or enqueued; any other has already ended and is left as it is. */
export function isCancellable(status: string): status is "running" | "enqueued" {
  return status === "running" || status === "enqueued";
}

/* What a cancel of a cancellable record is, given whether the queue aborted it as the job it was running. */
export function cancelCause(status: "running" | "enqueued", abortedLive: boolean): UnfinishedRunCause {
  if (abortedLive) return "cancelled-live";
  return status === "enqueued" ? "cancelled-enqueued" : "cancelled-inactive";
}
