/* Immutable record of a finished run — consumed by run-orchestration and cross-run-learning (neither depends on the other). errorClass/usage/reflection/adjudication stay wide so the kernel does not import those types from src/ or downstream contexts. */

import type { RunMode, TestTarget } from "./run-mode.ts";
import type { RunVerdict } from "./run-verdict.ts";
import type { QaCase } from "./qa-case.ts";
import type { ClosedLoopGateSignal } from "./closed-loop.ts";
import type { AgentBrowserGateSignal } from "./agent-browser.ts";
import type { CoordinationGateSignal } from "./coordination.ts";
import type { NoopKind } from "./noop-kind.ts";
import type { RouteAvailabilityGateSignal } from "./route-availability.ts";
import type { DataContradictionGateSignal } from "./data-contradiction.ts";
import type { ObservedDifference } from "./observed-difference.ts";

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
    /* What the change-coverage counted beside its ratio: the changed lines it took for code (`executableLines`), those it left out as no code, the changed files no loaded script mapped, the changed files it left out as no gap of the suite (`unreachableByDesign`: only reached through routes the change made unavailable, with those routes; `testSupportFiles`: only test files import them, with how many do), and, when a killed mutant's re-run added to it, the lines the passing tests ran by themselves and the lines and arms only a killed mutant made run. Absent when nothing was measured. */
    changeCoverage?: { executableLines: number; notExecutableLines?: number; notLoadedFiles?: string[]; unreachableByDesign?: { file: string; routes: string[] }[]; testSupportFiles?: { file: string; importers: number }[]; coveredByExecution?: number; provenByMutation?: number; armsProvenByMutation?: number };
    /* What the mutants of the changed code in the served script did: judged, noticed by a test, and where the others are; the sites on changed lines that were no candidate, counted by why (`skippedSites`), and the mutants that re-ran every test of their spec files (`rerunsBySpecFile`); a survivor carries `moved`, the request or line of the accessible tree the mutation moved between the same tests run with and without it, or that none did. A signal, never a gate; absent when no mutant was judged. */
    bundleMutation?: { applied: number; killed: number; survived: { file: string; line: number; operator: string; moved?: ObservedDifference }[]; skippedSites?: { count: number; reasons: Partial<Record<string, number>> }; rerunsBySpecFile?: number };
    /* What the one regeneration from the arms of the changed code no test ran did: its outcome, the arms before and after it, and how many spec files it changed kept their new bytes or were given their prior ones back (absent when it changed none). A signal, never a gate; absent when it did not run. */
    branchCases?: { outcome: "accepted" | "empty" | "rejected" | "capped"; armsBefore: number; armsAfter?: number; kept?: number; restored?: number };
    /* Whether the regeneration the surviving mutants drove made a test notice them: routed, judged (re-applied and reached a page), closed (a test now fails under it) and the ones still open. A signal, never a gate; absent when no accepted regeneration answered a survivor. */
    survivorClosure?: { routed: number; judged: number; closed: number; open: { file: string; line: number; operator: string }[] };
    /** The flaky cases of a flaky run (passed only on retry) by class and what the correction routed to their flows became, with the spec files it changed kept or given their prior bytes back (absent when it changed none); absent when the run was not flaky. A signal, never a gate. */
    flakyTriage?: { cases: number; dataInstability: number; timing: number; outcome: "no-pass" | "accepted" | "empty" | "rejected" | "capped"; kept?: number; restored?: number };
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
      /* Rounds whose model rejection lost every blocking finding to the evidence filter (so the round read as an approval), and the findings lost per reason. Absent when no round did. Persist-only: it reads nothing back into a verdict. */
      droppedRejections?: { rounds: number; reasons: Record<string, number> };
    };
    flaky: boolean;
    retries: number;
    confinement?: { strays: number; dangerous: number; reverted: string[] };
    /* Real type is agent-runtime's RunUsage; unknown keeps the kernel free of downstream dependencies. */
    usage?: unknown;
    phaseTimings?: Record<string, number>;
    /* The pipeline phase the run got furthest into (the canonical order is RUN_PHASES in run-step.ts). Absent when the run entered none. */
    furthestPhase?: string;
    preExecAmbiguityCatches?: number;
    deterministicSelectorBlocks?: number;
    /* Absent means the catalog gate never ran — never a fabricated 0. */
    catalogGateInWindow?: number;
    catalogGateAdvisory?: number;
    catalogGateFailClosed?: number;
    /* What the execution sandbox did for the run: whether the egress filter held ("unenforced" is the operator-allowed warn mode) and the hosts a child tried to reach that the run does not declare. Absent when no child was started. Persist-only. */
    sandbox?: { egress: "enforced" | "unenforced" | "not-applicable"; denied: string[] };
    /* Whether the reviewer judged with the generator's own model. Absent when the runtime assignment is unknown. Persist-only: it reads nothing back into a verdict. */
    reviewerIndependence?: "shared-model" | "distinct-model";
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
    /* Whether the run's failure is in the change's reach, and the evidence the label rests on (plain shape; the domain's CausalLabel). Absent when no case failed or the run was not decided. Persist-only: it records and decides nothing. */
    causal?: { reach: "in-reach" | "out-of-reach" | "unknown"; basis: "request" | "page" | "flow" | "none"; via: string[]; reason: string; cases: Array<{ name: string; reach: "in-reach" | "out-of-reach" | "unknown"; basis: "request" | "page" | "flow" | "none" }> };
    /* The share of each use case's changed lines the green run executed, or the reason it has none (`unmeasured`). Absent when the run asked for no use case or measured nothing. Persist-only: the aggregate ratio alone decides. */
    coverageByCandidate?: Array<{ candidateId: string; changedLines: number; coveredChanged: number; ratio: number | null; unmeasured?: string }>;
    /* The fault-injection score per use case the change makes testable: the specs exposed to a corrupted response of its operations and how many noticed, or why it has no ratio (`unscored`). Absent when the oracle was not aimed at any. Persist-only, never a gate. */
    valueByCandidate?: Array<{ candidateId: string; exposed: number; killed: number; ratio: number | null; unscored?: string }>;
    /* What the corrupted re-run counted: the baseline-passing specs it executed, those exposed to a corrupted response of an operation in reach, those that failed under it and the failures that were the flow breaking. Absent when it measured nothing. Persist-only: the input of the score's calibration. */
    valueStats?: { baseline: number; exposed: number; killed: number; failed: number; flowBreaks: number };
    /* Why the routes the Context Pack's capture could not show at their own address were not, by class. Absent when the pack did not classify. Persist-only: it reads nothing back into a verdict. */
    routeAvailability?: RouteAvailabilityGateSignal;
    /* The delivered tests that fulfil a stated response instead of reading DEV: how many spec files and tests, and the guards they broke (a fulfil no GET check guards, a changed request, a replay of every method, a spec file with no live test). Absent when no delivered test is stubbed and no guard broke. Persist-only: it reads nothing back into a verdict. */
    stubbedState?: { specFiles: number; tests: number; violations?: Array<{ file: string; kind: string }> };
    /* Which data sources of one captured page disagreed on what their items carry (a key one returns and a source of the same kind never does), from the response shapes the capture read. Absent when no page had a shape to read. Persist-only: it reads nothing back into a verdict. */
    dataContradictions?: DataContradictionGateSignal;
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
