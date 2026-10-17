/*
 * What a grader may read about one finished run: a plain read model, assembled by the shell from the run's record, its outcome
 * row, its agent turns and its span ledger. (`RunEvidence` already names another thing, in run-decision.service.ts.)
 * A field is absent, never zero, when the run did not record it.
 */

export interface RunEvaluationEvidence {
  runId: string;
  app: string;
  mode: string;
  /* False while the run is enqueued or running: nothing is graded then. */
  finished: boolean;
  /* An operator cancelled the run: only `infra_error` is graded for it. */
  cancelled: boolean;
  verdict: string | null;
  errorClass: string | null;
  /* "pr" | "issue" | "shadow-log" | "quarantine" | "none"; null when the run recorded none. */
  decision: string | null;
  /* The last pipeline phase the run entered (RUN_PHASES), null when it recorded none. */
  furthestPhase: string | null;
  /*
   * Specs delivered by this run. `valid` is null while unknown: validation gates the whole suite, so it is a measurement only
   * once the run got past the validate phase. `passed` is undefined when a delivered spec cannot be attributed to its cases.
   */
  specs: { generated: number; valid: number | null; passed: number | undefined };
  /* Reviewer turns on record, undefined when the run has no turn history at all (pruned, or never recorded). */
  reviewerTurns: number | undefined;
  /* Whether the engine ran a reviewer for this run, as it decided at run time. Undefined: the run recorded none. */
  reviewRequired: boolean | undefined;
  /* The run's outcome row; absent when the run produced none (a context run, a crash before the outcome). */
  signals:
    | {
        static: boolean;
        /* The reviewer's stored verdict; undefined when none was recorded. */
        reviewerApproved: boolean | undefined;
        /* The engine's own change-coverage decision at run time; undefined when the run recorded none (measured as nothing). */
        coverageStatus: "pass" | "fail" | "unknown" | undefined;
        /* The coverage policy mode in force at run time. */
        coverageMode: string | undefined;
        mutantCount: number | undefined;
        killedCount: number | undefined;
        catalogGateFailClosed: number | undefined;
      }
    | undefined;
  /* The limit that ended the run, when one did: the limit, the role it stopped and the intent of that turn's last step (undefined when unknown). */
  limit: { fired: string; role: string | undefined; intent: string | undefined } | undefined;
  /* Steps per intent, counted from the ledger's `chat` spans. Absent when no step carried an intent (Codex has no steps). */
  stepIntents: Readonly<Record<string, number>> | undefined;
  /* When the run ended, ISO-8601: the score timestamp. */
  finishedAt: string;
}
