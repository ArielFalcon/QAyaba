

import type { ActivityKindSchema, RunChangeEntrySchema } from "./contract/commands";
import type { z } from "zod";
import { RUN_MODES, type RunMode, type TestTarget, type TriggerSource } from "@kernel/run-mode";
import { RUN_ENGINE_STATUSES, engineStatus, type RunEngineStatus, type RunVerdict } from "@kernel/run-verdict";
import type { CaseStatus, QaCase } from "@kernel/qa-case";

export { RUN_MODES, RUN_ENGINE_STATUSES, engineStatus };
export type { RunMode, TestTarget, TriggerSource, RunEngineStatus, RunVerdict, CaseStatus, QaCase };

/*
 * Structured metadata the agent emits per spec — the day-one fields (objective, flow,
 * targets) the orchestrator uses for deterministic manifest upsert. Complements the
 * flat `specs: string[]` in AgentResult for backward compatibility.
 */
export interface SpecMeta {
  file: string;     /* spec file name, e.g. "login.spec.ts" */
  flow: string;     /* user flow, e.g. "login" */
  objective: string;  /* acceptance criterion */
  targets: string[];   /* symbols/routes the spec exercises */
  sha256?: string;  /* content checksum for integrity verification */
}


export interface RunOptions {
  target?: TestTarget;  /* defaults to "e2e" when omitted */
  mode: RunMode;
  guidance?: string;  /* used by "manual" and by a human-in-the-loop continuation */
  /*
   * Continuation: seed the FIRST generation with these previously-failed cases (so the
   * agent fixes them) and record the run it continues.
   */
  fixCases?: QaCase[];
  parentRunId?: string;
  previousNamespace?: string;  /* cleanup: namespace from an interrupted previous run */
  runId?: string;  /* the tracked run id; scopes the data/coverage namespace per run */
  triggerRepo?: string;  /* cross-repo: the service repo whose commit triggered this run */
  commits?: number;  /* diff mode: how many commits ending at the SHA the diff spans (default 1) */
  /*
   * PR/push range: when set and != the head sha, the diff spans baseSha..sha (the whole PR),
   * not just the tip commit. Absent → single-commit behavior (unchanged).
   */
  baseSha?: string;
}

/*
 * Outcome of an OpenCode agent run. The agent writes the E2E tests directly into
 * the working copy's `e2e/` folder (git is the source of truth, not this object);
 * only the reviewer subagent's verdict (resolved inside OpenCode) and the final
 * text travel here.
 */
export interface AgentResult {
  output: string;  /* the agent's final text, including its closing verdict */
  specs: string[];  /* names of the specs it reported writing/updating */
  specMetas?: SpecMeta[];  /* structured metadata per spec (flow, objective, targets) */
  reviewed: boolean;  /* whether review was enabled */
  approved: boolean;  /* reviewer verdict (true when not reviewed) */
  note?: string;  /* reason when not approved (e.g. did not converge) */
  /*
   * Browser NAVIGATIONS (route visits) the agent made THIS turn (re-exploration telemetry;
   * counts `navigate`, not snapshots). Threaded into the fix-loop's RoundResult so the progress gate can
   * treat a heavy-re-navigation retry that merely reshuffles the failure set as "no progress".
   * Absent ⇒ treated as 0 (no gating).
   */
  reexploreNavigations?: number;

  objectiveCount?: number;
}


export interface QaRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean;
  cases: QaCase[];
  logs: string;
  note?: string;  /* human-readable summary of what happened (reviewer rejection, skip reason, etc.) */
  outcome?: string;  /* what the run PRODUCED — "suite PR merged · <url>", "Issue filed · <url>", etc. */
}

/* A single spec produced by the AI agent with its objective and flow path. */
export interface SpecRecord {
  name: string;
  objective?: string;
  flow?: string;
}

/*
 * A structured, real-time activity event for the TUI. `kind` (and `status` for todos) lets the
 * dashboard categorize a live panel. Raw model-stream prose is never an activity.
 */
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export interface AgentActivity {
  kind: ActivityKind;
  text: string;              /* already clean: file basename, full command, or todo content */
  status?: "pending" | "in_progress" | "completed";  /* todos only */
  ts: string;                /* ISO timestamp — for ordering and elapsed */
}

/* Full run history record persisted in SQLite (src/server/persistence/repositories/run.repository.ts). */
export type RunChangeEntry = z.infer<typeof RunChangeEntrySchema>;

export interface RunRecord {
  id: string;
  app: string;
  sha: string;
  ref?: string;
  target: TestTarget;
  mode: RunMode;
  status: "enqueued" | "running" | "done";
  step?: string;
  stepDetail?: string;
  verdict?: RunVerdict;
  /* Derived from `verdict` at egress (never stored) — present only once the run is `done`. */
  engineStatus?: RunEngineStatus;
  passed?: number;
  failed?: number;
  note?: string;
  retrying?: boolean;
  parentRunId?: string;
  triggerRepo?: string;  /* cross-repo runs: the service repo that originated the event */
  changeSet?: RunChangeEntry[];  /* every repo's change the run reads, when other pushes joined it before it started */
  cases: QaCase[];
  specs?: SpecRecord[];
  logs: string[];
  activity?: AgentActivity[];   /* structured live activity feed (newest last) */
  stepStartedAt?: string;       /* ISO time the current `step` began — drives the elapsed clock */
  at: string;
}

export type IncidentSeverity = "warn" | "error" | "critical";
export type IncidentSource = "health-check" | "log-scraper" | "qa-author" | "qa-reviewer" | "cli" | "process-audit";

export interface Incident {
  id: string;
  source: IncidentSource;
  severity: IncidentSeverity;
  summary: string;
  detail?: string;
  status: "pending" | "diagnosing" | "fixed" | "dismissed";
  at: string;
  prUrl?: string;
}


export type { ErrorClass } from "@kernel/error-class";

export interface RunOutcome {
  runId: string;
  app: string;
  sha: string;
  mode: RunMode;
  target: TestTarget;
  verdict: RunVerdict;
  errorClass: import("@kernel/error-class").ErrorClass | null;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    /* Real value-oracle counts when measured; absent means it never measured this run — never a
     * fabricated 0 (indistinguishable from a genuine measured zero). */
    mutantCount?: number;
    killedCount?: number;
    /* The arms of the decisions on changed lines and how many ran; absent when none was seen. A signal, never a gate. */
    branchCoverage?: { changed: number; taken: number };
    /* What the mutants of the changed code did; absent when none was judged. A signal, never a gate. */
    changeCoverage?: { executableLines: number; notExecutableLines?: number; notLoadedFiles?: string[]; coveredByExecution?: number; provenByMutation?: number; armsProvenByMutation?: number };
    bundleMutation?: { applied: number; killed: number; survived: { file: string; line: number; operator: string }[] };
    /* What the one regeneration from the arms of the changed code no test ran did: its outcome and the arms before and after it. A signal, never a gate; absent when it did not run. */
    branchCases?: { outcome: "accepted" | "empty" | "rejected" | "capped"; armsBefore: number; armsAfter?: number };
    /** The flaky cases of a flaky run (passed only on retry) by class and what the correction routed to their flows became; absent when the run was not flaky. A signal, never a gate. */
    flakyTriage?: { cases: number; dataInstability: number; timing: number; outcome: "no-pass" | "accepted" | "empty" | "rejected" | "capped" };
    /* The reviewer's missing cases: findings that cite an arm of the changed code no test ran. A record, never a gate; absent when there were none. */
    missingCases?: string[];
    reviewerCorrections: string[];
    /*
     * The reviewer's one/two-sentence reasoning for its verdict — on APPROVAL too, not only
     * rejection. The reviewer is the keystone publish gate; without this, a wrong auto-merge
     * (green-but-meaningless test that ships) leaves no durable record of WHY it was approved.
     */
    reviewerRationale?: string;
    /*
     * The reviewer's APPROVE/REJECT verdict, persisted so the end-of-run value report (CLI, TUI)
     * can state it without re-deriving from corrections. Absent when review was disabled/not reached.
     */
    reviewerApproved?: boolean;
    /* What the review phase cost and decided. Absent when no reviewer phase ran. Persist-only. */
    reviewer?: {
      rounds: number;
      modelRounds: number;
      approved: boolean;
      corrections: number;
      blocking: number;
      durationMs: number;
      promptBytes: number;
      outputTokens: number | null;
      costUsd: number | null;
      steps: number | null;
      preCheckRejects: number;
      skippedRounds: number;
      /* The class of the final blocking correction (`none` when approved), from the closed review tags. */
      correctionClass?: string;
      /* Rounds whose model rejection lost every blocking finding to the evidence filter, and the findings lost per reason. Absent when no round did. */
      droppedRejections?: { rounds: number; reasons: Record<string, number> };
    };
    flaky: boolean;
    retries: number;
    /*
     * Write-confinement guard: set when the guard ran (dep wired), absent when dep not wired.
     * { strays: 0, dangerous: 0, reverted: [] } is a positive "guard ran, clean" record.
     */
    confinement?: { strays: number; dangerous: number; reverted: string[] };
    /*
     * Per-run agent token/cost usage — observation-only, never affects verdict or publish.
     * Absent only when no snapshot fired AND no provider attribution is available (dep not wired).
     * For a run with no token snapshots, present with zero tokens and provider attribution fields
     * so the run is attributable without re-deriving provider from config. complete=false then.
     */
    usage?: import("./qa/usage").RunUsage;
    /*
     * Per-subphase wall-clock timing (ms), accumulated per phase label. Observation-only.
     * Absent on a run that recorded nothing (e.g. a pre-classify skip). Never affects verdict.
     */
    phaseTimings?: Record<string, number>;
    /* The pipeline phase the run got furthest into. Absent when the run entered none. */
    furthestPhase?: string;
    /*
     * Pre-execution deterministic selector check (observation-only). `preExecAmbiguityCatches`:
     * strict-mode ambiguities against the live pre-write DOM, an advisory the run only counts and
     * logs (the check is a regex over the spec text: real execution decides, so it never asks for a
     * regeneration or folds the verdict). `deterministicSelectorBlocks`: how many of them held the
     * run; always 0 since the check became advisory, kept so earlier runs and the benchmark read
     * the same record. Absent when the check did not run.
     */
    preExecAmbiguityCatches?: number;
    deterministicSelectorBlocks?: number;
    /*
     * Catalog gate (observation-only): test-id selectors gated in the confident window vs left
     * advisory, and fabricated test-ids caught pre-execution.
     */
    catalogGateInWindow?: number;
    catalogGateAdvisory?: number;
    catalogGateFailClosed?: number;
    /* What the execution sandbox did for the run (egress filter state, hosts denied); absent when no child was started. */
    sandbox?: { egress: "enforced" | "unenforced" | "not-applicable"; denied: string[] };
    /* Whether the reviewer judged with the generator's own model; absent when the runtime assignment is unknown. */
    reviewerIndependence?: "shared-model" | "distinct-model";
    /* How the generator used run_spec this run and whether the loop ended closed; absent when the tool was not granted. */
    closedLoop?: { calls: number; devWrites: number; closed: boolean; granted?: number; writesRefused?: number };
    /* How the authoring agents used the authenticated browser this run; absent when it was not granted. */
    agentBrowser?: { calls: number; blocks: number; invalidations: number; renewals: number; granted?: number };
    /* How the run was coordinated: what became of the lead's plan and its flows; absent for a run that did not coordinate (a code or context run). A record stored earlier may also carry a `mode`. */
    coordination?: { plan?: string; refusal?: string; flows: number; delivered: number; incomplete: number; authoring?: string };
    /* The reason a declared no-op named (`unspecified` when it named none); absent for a run that is not one. Persist-only. */
    noop?: { kind: "not-worth" | "unobservable" | "unspecified" };

    structuralSignalBytes?: number;
    serviceLinksCount?: number;
    contractDriftCount?: number;

    crossRepoImpactedCount?: number;
    /* The coverage signal was measured before the specs an accepted regeneration rewrote: the ratio no longer describes the bytes on disk. Persist-only. */
    coverage?: { stale: boolean };
    /* The value score has the same staleness (an accepted regeneration rewrote the suite). Persist-only, never a gate. */
    value?: { stale: boolean };
    /* Whether the run's failure is in the change's reach and the evidence for it; absent when no case failed. Persist-only, never a gate. */
    causal?: { reach: "in-reach" | "out-of-reach" | "unknown"; basis: "request" | "page" | "flow" | "none"; via: string[]; reason: string; cases: Array<{ name: string; reach: "in-reach" | "out-of-reach" | "unknown"; basis: "request" | "page" | "flow" | "none" }> };
    /* The share of each use case's changed lines the green run executed, or the reason it has none (`unmeasured`). Absent when the run asked for no use case or measured nothing. Persist-only: the aggregate ratio alone decides. */
    coverageByCandidate?: Array<{ candidateId: string; changedLines: number; coveredChanged: number; ratio: number | null; unmeasured?: string }>;
    /* The fault-injection score per use case the change makes testable: the specs exposed to a corrupted response of its operations and how many noticed, or why it has no ratio (`unscored`). Absent when the oracle was not aimed at any. Persist-only, never a gate. */
    valueByCandidate?: Array<{ candidateId: string; exposed: number; killed: number; ratio: number | null; unscored?: string }>;
    /* What the corrupted re-run counted: the baseline-passing specs it executed, those exposed to a corrupted response of an operation in reach, those that failed under it and the failures that were the flow breaking. Absent when it measured nothing. Persist-only: the input of the score's calibration. */
    valueStats?: { baseline: number; exposed: number; killed: number; failed: number; flowBreaks: number };
    /* How the run's regeneration acceptance spent its proof ledger. Persist-only. */
    integrity?: { acceptances: number; rejected: number; proofReused: number; capHit: boolean };
    /* The test-intent lock: derived clauses, deltas and would-be rejections, with the opacity flag. Persist-only. */
    intent?: { mode: string; violations: number; wouldReject: number; clauses: number; opaque: number; opacityHigh: boolean };
  };
  rulesRetrieved: string[];
  reflection?: StructuredReflection;
  at: string;
}

export interface StructuredReflection {
  goal: string;
  decision: string;
  assumption: string;
  errorClass: import("@kernel/error-class").ErrorClass;
  gateSignal: string;
  evidence: string;
  rootCause: string;
  preventiveRule: { trigger: string; action: string };
}
