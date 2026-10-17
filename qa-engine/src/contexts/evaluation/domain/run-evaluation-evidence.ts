/*
 * What a grader may read about one finished run: a plain read model, assembled by the shell from the run's record, its outcome
 * row, its agent turns and its span ledger. (`RunEvidence` already names another thing, in run-decision.service.ts.)
 * A field is absent, never zero, when the run did not record it.
 */

/* The change-coverage threshold the engine applies when the app declares none. */
export const DEFAULT_COVERAGE_MIN_RATIO = 0.7;

export interface RunEvaluationEvidence {
  runId: string;
  app: string;
  mode: string;
  /* False while the run is enqueued or running: nothing is graded then. */
  finished: boolean;
  verdict: string | null;
  errorClass: string | null;
  /* "pr" | "issue" | "shadow-log" | "quarantine" | "none"; null when the run recorded none. */
  decision: string | null;
  /* The last pipeline phase the run entered (RUN_PHASES), null when it recorded none. */
  furthestPhase: string | null;
  /* Specs delivered by this run, how many passed validation, how many passed on execution. */
  specs: { generated: number; valid: number; passed: number };
  /* Agent turns of the reviewer role. */
  reviewerTurns: number;
  /* False only when the app turned review off. Undefined: not known, treated as required. */
  reviewRequired: boolean | undefined;
  /* The run's outcome row; absent when the run produced none (a context run, a crash before the outcome). */
  signals:
    | {
        static: boolean;
        /* null: the coverage signal never measured the run. */
        coverageRatio: number | null;
        coverageMinRatio: number;
        /* The app's coverage policy mode when known ("off" | "signal" | "enforce"). */
        coverageMode: string | undefined;
        mutantCount: number | undefined;
        killedCount: number | undefined;
        catalogGateFailClosed: number | undefined;
      }
    | undefined;
  /* The limit that ended the run, when one did: a value of the limit vocabulary and the role it stopped. */
  limit: { fired: string; role: string | undefined } | undefined;
  /* Steps per intent, counted from the ledger's `chat` spans. Absent when no step carried an intent (Codex has no steps). */
  stepIntents: Readonly<Record<string, number>> | undefined;
  /* When the run ended, ISO-8601: the score timestamp. */
  finishedAt: string;
}
