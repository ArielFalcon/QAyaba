/** What a run is asked when it opens the lead's code-graph tools. */
export interface CodeGraphToolsOpenInput {
  runId: string;
}

/** The lead's code-graph right for one run: its limits, what was used of it, and its end. */
export interface CodeGraphToolsHandle {
  limits: { maxCalls: number; maxFiles: number; maxAnswerChars: number };
  signals(): { calls: number; refused: number; failed: number };
  /** Gives an explore sidekick of a delegation the calls it may make out of the run's: never more than the run has left when it is granted. */
  grantShare(delegationId: string, calls: number): void;
  /** Revokes the right. Never throws. */
  close(): void;
}
