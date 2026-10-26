import type { JudgeName } from "../../domain/judges.ts";
import type { JudgeAttempt, JudgeOutcome } from "../../domain/judge-evidence.ts";

export interface JudgeLedgerPort {
  record(attempt: JudgeAttempt): void;
  /* The latest outcome recorded for the run, judge and prompt version; undefined when never attempted. */
  lastOutcome(runId: string, judge: JudgeName, promptVersion: string): JudgeOutcome | undefined;
  /* Tokens the attempts of a UTC day (YYYY-MM-DD) used. */
  tokensUsedOn(day: string): number;
}
