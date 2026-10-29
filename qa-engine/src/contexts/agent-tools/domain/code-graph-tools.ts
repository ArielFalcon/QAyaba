/** What a run is asked when it opens the lead's code-graph tools. */
export interface CodeGraphToolsOpenInput {
  runId: string;
}

/** The lead's code-graph right for one run: its limits, what was used of it, and its end. */
export interface CodeGraphToolsHandle {
  limits: { maxCalls: number; maxFiles: number; maxAnswerChars: number };
  signals(): { calls: number; refused: number; failed: number };
  /** Revokes the right. Never throws. */
  close(): void;
}
