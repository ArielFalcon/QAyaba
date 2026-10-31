/**
 * The commit's intent as the run ports carry it. `type` is a plain string here; generation's own
 * CommitIntent narrows it to the conventional-commit types and is structurally assignable to this one.
 */
export interface CommitIntent {
  type: string;
  breaking: boolean;
  /** First line — the agent uses this as intent. */
  message: string;
  /** Commit body after the subject — the richest statement of intent. */
  body?: string;
  /** The agent derives scope/area from these paths. */
  changedFiles: string[];
}
