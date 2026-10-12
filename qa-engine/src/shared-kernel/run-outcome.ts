/* Immutable record of a finished run — consumed by qa-run-orchestration and cross-run-learning (neither depends on the other). errorClass/usage/reflection/adjudication stay wide so the kernel does not import those types from src/ or downstream contexts. */

import type { RunMode, TestTarget } from "./run-mode.ts";
import type { RunVerdict } from "./run-verdict.ts";
import type { QaCase } from "./qa-case.ts";
import type { ClosedLoopGateSignal } from "./closed-loop.ts";
import type { AgentBrowserGateSignal } from "./agent-browser.ts";
import type { CoordinationGateSignal } from "./coordination.ts";

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
    reviewerCorrections: string[];
    reviewerRationale?: string;
    reviewerApproved?: boolean;
    flaky: boolean;
    retries: number;
    confinement?: { strays: number; dangerous: number; reverted: string[] };
    /* Real type is agent-runtime's RunUsage; unknown keeps the kernel free of downstream dependencies. */
    usage?: unknown;
    phaseTimings?: Record<string, number>;
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
    /* How the run was coordinated when it asked for the lead/sidekick mode: what became of the plan, how many flows were authored, delivered and left unfinished, and whether the lead took over. Absent for a run in the single mode. Persist-only: it reads nothing back into a verdict. */
    coordination?: CoordinationGateSignal;
    /* Undefined = the signal never ran — never a fabricated 0 (that would be indistinguishable from "ran and found zero"). Persist-only; never read by decide/verdict/gate/publish. */
    structuralSignalBytes?: number;
    serviceLinksCount?: number;
    contractDriftCount?: number;
    crossRepoImpactedCount?: number;
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
