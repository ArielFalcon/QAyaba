/* Immutable record of a finished run — consumed by qa-run-orchestration and cross-run-learning (neither depends on the other). errorClass/usage/reflection/adjudication stay wide so the kernel does not import those types from src/ or downstream contexts. */

import type { RunMode, TestTarget } from "./run-mode.ts";
import type { RunVerdict } from "./run-verdict.ts";
import type { QaCase } from "./qa-case.ts";

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
    /* Undefined = the signal never ran — never a fabricated 0 (that would be indistinguishable from "ran and found zero"). Persist-only; never read by decide/verdict/gate/publish. */
    structuralSignalBytes?: number;
    serviceLinksCount?: number;
    contractDriftCount?: number;
    crossRepoImpactedCount?: number;
  };
  rulesRetrieved: string[];
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
