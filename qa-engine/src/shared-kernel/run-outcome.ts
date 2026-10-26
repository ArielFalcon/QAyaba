/* Immutable record of a finished run — consumed by qa-run-orchestration and cross-run-learning (neither depends on the other). errorClass/usage/reflection/adjudication stay wide so the kernel does not import those types from src/ or downstream contexts. */

import type { RunMode, TestTarget } from "./run-mode.ts";
import type { RunVerdict } from "./run-verdict.ts";
import type { QaCase } from "./qa-case.ts";
import type { ClosedLoopGateSignal } from "./closed-loop.ts";
import type { AgentBrowserGateSignal } from "./agent-browser.ts";
import type { CoordinationGateSignal } from "./coordination.ts";
import type { NoopKind } from "./noop-kind.ts";

export type ErrorClass = string | null;

export interface RunOutcome {
  runId: string;
  app: string;
  sha: string;
  mode: RunMode;
  target: TestTarget;
  verdict: RunVerdict;
  errorClass: ErrorClass;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    /* Absent means the value-oracle never measured this run — never a fabricated 0 (indistinguishable from a genuine measured zero). */
    mutantCount?: number;
    killedCount?: number;
    /* The arms of the decisions on changed lines and how many ran: a signal beside coverageRatio, never a gate. Absent when no decision was seen on a changed line. */
    branchCoverage?: { changed: number; taken: number };
    /* What the mutants of the changed code in the served script did: judged, noticed by a test, and where the others are. A signal, never a gate; absent when no mutant was judged. */
    bundleMutation?: { applied: number; killed: number; survived: { file: string; line: number; operator: string }[] };
    /* What the one regeneration from the arms of the changed code no test ran did: its outcome and the arms before and after it. A signal, never a gate; absent when it did not run. */
    branchCases?: { outcome: "accepted" | "empty" | "rejected" | "capped" | "deadline"; armsBefore: number; armsAfter?: number };
    /* The reviewer's missing cases: findings that cite an arm of the changed code no test ran. A record, never a gate; absent when there were none. */
    missingCases?: string[];
    /* The value score describes bytes an accepted regeneration rewrote. Signal-only: recorded, never a gate. */
    value?: { stale: boolean };
    /*
     * The test-intent lock: what this run derived and what it would have rejected. `wouldReject` counts
     * regenerations that were accepted only because the policy is `signal`; the opacity flag is
     * telemetry and never blocks. Absent when the lock is off or no contract was derived.
     */
    intent?: {
      mode: string;
      violations: number;
      wouldReject: number;
      clauses: number;
      opaque: number;
      opacityHigh: boolean;
    };
    reviewerCorrections: string[];
    reviewerRationale?: string;
    reviewerApproved?: boolean;
    /*
     * What the review phase cost and what it decided, round by round: the reviewer's own duration,
     * tokens and steps where its runtime reported them, the number of rounds a deterministic check or
     * an unchanged-spec round resolved without an LLM call, and the final corrections count. Absent
     * when no reviewer phase ran. Persist-only; it reads nothing back into a verdict.
     */
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
      /* The findings the generator disputed instead of correcting; `withdrawn` is how many the orchestrator verified. Absent when no rebuttal arrived. */
      rebuttals?: { received: number; withdrawn: number };
    };
    flaky: boolean;
    retries: number;
    confinement?: { strays: number; dangerous: number; reverted: string[] };
    /* Real type is agent-runtime's RunUsage; unknown keeps the kernel free of downstream dependencies. */
    usage?: unknown;
    phaseTimings?: Record<string, number>;
    /* The pipeline phase the run got furthest into (the canonical order lives in qa-run-orchestration's run-phase-cursor). Absent when the run entered none. */
    furthestPhase?: string;
    preExecAmbiguityCatches?: number;
    deterministicSelectorBlocks?: number;
    /* Absent means the catalog gate never ran — never a fabricated 0. */
    catalogGateInWindow?: number;
    catalogGateAdvisory?: number;
    catalogGateFailClosed?: number;
    /* What the execution sandbox did for the run: whether the egress filter held ("unenforced" is the operator-allowed warn mode) and the hosts a child tried to reach that the run does not declare. Absent when no child was started. Persist-only. */
    sandbox?: { egress: "enforced" | "unenforced" | "not-applicable"; denied: string[] };
    /* How the generator used run_spec this run, and whether the loop ended closed. Absent when the run did not grant the tool. Persist-only: it reads nothing back into a verdict. */
    closedLoop?: ClosedLoopGateSignal;
    /* How the authoring agents used the authenticated browser this run: calls, requests the guard refused, sessions lost and renewed. Absent when the run did not grant it. Persist-only: it reads nothing back into a verdict. */
    agentBrowser?: AgentBrowserGateSignal;
    /* How the run was coordinated: what became of the plan, how many flows were authored, delivered and left unfinished, and whether the lead took over. Absent for a run that did not coordinate (a code or context run). Persist-only: it reads nothing back into a verdict. */
    coordination?: CoordinationGateSignal;
    /* The reason a declared no-op named (`noop.kind` of its verdict, `unspecified` when it named none). Absent for a run that is not one. Persist-only: it reads nothing back into a verdict. */
    noop?: { kind: NoopKind };
    /* Undefined = the signal never ran — never a fabricated 0 (that would be indistinguishable from "ran and found zero"). Persist-only; never read by decide/verdict/gate/publish. */
    structuralSignalBytes?: number;
    serviceLinksCount?: number;
    contractDriftCount?: number;
    crossRepoImpactedCount?: number;
    /* The coverage signal was measured before the specs an accepted regeneration rewrote: the recorded ratio no longer describes the bytes on disk. Persist-only; never read by decide/verdict/gate/publish. */
    coverage?: { stale: boolean };
    /* How the run's regeneration acceptance spent its proof ledger: how many regenerations were accepted (and how many of those reused a closed-loop proof instead of executing), how many were rejected, and whether the per-run execution cap was hit. Persist-only; never read by decide/verdict/gate/publish. */
    integrity?: { acceptances: number; rejected: number; proofReused: number; capHit: boolean };
  };
  rulesRetrieved: string[];
  /* Structural pattern kinds of the run's diff (detectStructuralPatterns, "generic" included). The learning fold credits a retrieved rule only when it is attributable to them — untagged, or tagged with one of these kinds. Absent when the run had no diff to read (non-diff modes): every retrieved rule then stays attributable. Fold input only; the run_outcomes row does not store it. */
  diffArchetypes?: string[];
  /* Real type is cross-run-learning's StructuredReflection; unknown for the same layering reason. */
  reflection?: unknown;
  /* Human-readable terminal reason. Absent means no diagnostic was captured — never a fabricated empty string. */
  note?: string;
  at: string;
  /* Absent only when execution never ran. Never a fabricated empty array standing in for "unknown". */
  cases?: QaCase[];
  logs?: string;
  /* FixLoop adjudicator verdict. `class` is string, not the domain union — the kernel must not import that type. Absent means the adjudicator never ran. app_defect must never teach the flywheel to weaken a test that correctly caught a real bug. */
  adjudication?: { class: string; confidence?: string; action?: string; reason?: string };
}
