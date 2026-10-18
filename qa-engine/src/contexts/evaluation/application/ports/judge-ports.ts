/* The ports of the LLM-judge use cases (docs/observability-design.md section 11.3). The shell implements them over SQLite and the agent runtime. */

import type { JudgeEvidence, JudgeName, JudgeStatus } from "../../domain/judges.ts";
import type { CalibrationReport, LabeledPair } from "../../domain/judge-calibration.ts";

export interface JudgeEvidencePort {
  /* Undefined: no such run, or one that is not finished. */
  load(runId: string): JudgeEvidence | undefined;
}

export interface JudgeAnswer {
  output: string;
  /* Tokens the call used (input + output + reasoning) when the runtime said; null when it did not. */
  tokens: number | null;
  /* The model that answered, when the runtime said. */
  model: string | undefined;
}

/* One call to the tool-less judge role. Throws when the call fails; the use case records it and goes on. */
export interface JudgeAgentPort {
  ask(prompt: string, signal?: AbortSignal): Promise<JudgeAnswer>;
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

export interface JudgeLedgerPort {
  record(attempt: JudgeAttempt): void;
  /* The latest outcome recorded for the run, judge and prompt version; undefined when never attempted. */
  lastOutcome(runId: string, judge: JudgeName, promptVersion: string): JudgeOutcome | undefined;
  /* Tokens the attempts of a UTC day (YYYY-MM-DD) used. */
  tokensUsedOn(day: string): number;
}

export interface JudgePairs {
  graderVersion: string;
  promptVersion: string;
  model: string;
  pairs: LabeledPair[];
}

export interface CalibrationPairsPort {
  /* The human labels paired with the judge's scores of the same runs: the newest prompt version and model the judge has scores for. Undefined: it has none. */
  pairsFor(judge: JudgeName): JudgePairs | undefined;
}

export interface CalibrationStorePort {
  save(report: CalibrationReport): void;
  /* The newest report of the judge for exactly this prompt version, or undefined. */
  latest(judge: JudgeName, promptVersion: string): CalibrationReport | undefined;
}

/* What the catalog and a consumer read: the judge's status for the prompt in force. */
export type JudgeStatusLookup = (judge: JudgeName) => JudgeStatus;

/* What the regrade use case needs from the judges: whether a request naming a judge can be taken, and a way to hand a run to them. */
export interface JudgeRegradePort {
  /* Why a request naming a judge cannot be taken (judges off, role missing), or undefined when it can. */
  unavailable(): string | undefined;
  /* Hands the run to the judges' low-priority job. `unavailable-run` when the run does not exist or has not finished. */
  request(runId: string, judges: readonly JudgeName[]): "scheduled" | "unavailable-run";
}
