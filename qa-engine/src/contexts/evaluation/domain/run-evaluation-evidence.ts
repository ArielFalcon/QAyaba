/*
 * What a grader may read about one finished run: a plain read model, assembled by the shell from the run's record, its outcome
 * row, its agent turns and its span ledger. (`RunEvidence` already names another thing, in run-decision.service.ts.)
 * A field is absent, never zero, when the run did not record it.
 */

/* One item a delivered source left out. `route` attributes a DOM cut (node-cap/line-cap) to the page it lost nodes on, so a cut
 * on a page that is not change-relevant never makes the run incomplete. */
export interface DeliveredOmission {
  class: "selection" | "truncation";
  reason: string;
  count: number;
  route?: string;
}

/* What one grounding source actually handed the agent, read from the delivered span. */
export interface DeliveredContextSource {
  source: string;
  ids: string[];
  bytes: number;
  /* Items left out (selection + truncation), the delivered span's `qayaba.context.omitted`. */
  omitted: number;
  /* The per-reason breakdown; empty when the span recorded only the total (the reasons are a Track A addition). */
  omissions: DeliveredOmission[];
  /* Ids the span could not list past its cap (`qayaba.context.item_ids.overflow`): `ids` is then not every item delivered. */
  idsOverflow?: number;
}

/* Freshness provenance, absent until Track A batch 4 records it. Absent means the fresh score is omitted, never false. */
export interface ContextFreshness {
  /* Sources that were stale when the generator used them, each with its reason. */
  stale: Array<{ source: string; reason: string }>;
  /* The change-relevant DOM differed between two captures of the same page. */
  domChanged: boolean | undefined;
}

/* The grounding evidence a context grader reads: delivered sources, the change-relevant subset, what the agent referenced and
 * the changed-element observability. Fields are absent, never fabricated, when the run did not record them. */
export interface ContextEvidence {
  delivered: DeliveredContextSource[];
  /* Change-relevant route ids, in rank order (the diff's ranked routes and their delivered template instances). */
  relevantIds: string[];
  /* The component/page each relevant route belongs to, parallel to `relevantIds`; empty when the grouping was not recorded. */
  relevantGroups: string[];
  /* Test ids of the change's identifiable elements. Empty when the diff identified none (a label-only change). */
  changedTestIds: string[];
  /* present (an identified element was captured), absent (identified but no page showed it) or unknown (nothing identified). */
  changedElement: "present" | "absent" | "unknown" | undefined;
  snapshots: Array<{ path: string; text: string }>;
  toolSequence: Array<{ tool: string; target: string | null }>;
  /* Reads of content the prompt already provided, a waste signal, not use. */
  fileReads: number | undefined;
  freshness: ContextFreshness | undefined;
}

/* The lead's plan as the run kept it, with each flow's result in the final execution. */
export interface PlanEvidence {
  /* "noop" | "lead" | "fanout". */
  kind: string;
  /* The pages of the app's map the change is linked to. */
  changeRoutes: readonly string[];
  flows: ReadonlyArray<{
    id: string;
    /* The change pages the flow visits. */
    visits: readonly string[];
    /* Whether the flow delivered a spec and every case of it passed the final execution: false when it delivered none or a case failed; undefined when the run's cases cannot be tied to its spec. */
    passed: boolean | undefined;
  }>;
}

/* One `run_spec` call the orchestrator served or refused (`qayaba.tool.run_spec`), in the order the calls were made. */
export interface RunSpecCallEvidence {
  path: string;
  /* The sha256 of the bytes that ran; absent on a refused call. */
  sha256: string | undefined;
  /* passed | failed | timedOut | error | refused. */
  outcome: string;
  /* The refusal code of a refused call. */
  refusal: string | undefined;
}

/* A spec the run delivered: its final bytes and how it did in the final execution. */
export interface DeliveredSpecEvidence {
  path: string;
  /* The sha256 of its newest delivered snapshot; undefined when none was kept. */
  sha256: string | undefined;
  /* Every case tied to it passed the final execution; undefined when the run did not execute or no case can be tied to it. */
  passed: boolean | undefined;
}

/* What a sidekick reported one turn of its flow came to, beside how the flow's last run_spec call had ended then (a delegation event). */
export interface SidekickReportEvidence {
  delegationId: string;
  attempt: number | undefined;
  /* The sidekick's own status (DelegationStatus). */
  status: string;
  /* The flow's last run_spec outcome when it reported; undefined when the flow had made no call. */
  lastRunSpec: string | undefined;
}

export interface RunEvaluationEvidence {
  runId: string;
  /* The run this one rebuilds/continues (a context heal, a /continue). Diagnostic lineage only: freshness never reads it. */
  parentRunId?: string;
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
  /* The grounding evidence (delivered sources, references, changed-element): absent when the run recorded none. */
  context: ContextEvidence | undefined;
  /* What the lead planned and how its flows ended (`run_plans`); absent when the run kept no plan (it did not coordinate, or nothing was kept). */
  plan: PlanEvidence | undefined;
  /* The closed loop's run_spec calls; empty when the run made none. */
  runSpecCalls: readonly RunSpecCallEvidence[];
  /* The specs the run delivered, with their final bytes and final-execution result. */
  deliveredSpecs: readonly DeliveredSpecEvidence[];
  /* Each sidekick turn's report that recorded its status; empty for a run without sidekicks or recorded before reports carried it. */
  sidekickReports: readonly SidekickReportEvidence[];
  /* When the run ended, ISO-8601: the score timestamp. */
  finishedAt: string;
}
