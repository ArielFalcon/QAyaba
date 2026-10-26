import type { JudgeName, JudgeStatus } from "./judges.ts";
import type { LabeledPair } from "./judge-calibration.ts";

export interface JudgeAnswer {
  output: string;
  /* Tokens the call used (input + output + reasoning) when the runtime said; null when it did not. */
  tokens: number | null;
  /* The model that answered, when the runtime said. */
  model: string | undefined;
}

export type JudgeOutcome = "scored" | "unparseable" | "not_applicable" | "error";

export interface JudgeAttempt {
  runId: string;
  judge: JudgeName;
  promptVersion: string;
  model: string | null;
  outcome: JudgeOutcome;
  tokens: number;
  /* Why, for anything but `scored`. Capped by the adapter. */
  detail: string | null;
  at: string;
}

export interface JudgePairs {
  graderVersion: string;
  promptVersion: string;
  model: string;
  pairs: LabeledPair[];
}

/* What the catalog and a consumer read: the judge's status for the prompt in force. */
export type JudgeStatusLookup = (judge: JudgeName) => JudgeStatus;
