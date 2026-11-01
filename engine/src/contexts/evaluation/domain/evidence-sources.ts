/*
 * What the evidence of one finished run is derived from: the run's record, its outcome row, its agent turns, its span ledger, its spec
 * snapshots and its plan. Each is the slice the derivations read, so the history store's rows satisfy them without the engine knowing the
 * store. Where the run never recorded a fact it is undefined or null here, and the evidence says so.
 */
import type { QaCase, SpecRecord } from "@kernel/qa-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { LedgerSpan } from "./ledger-span.ts";

export interface EvidenceRunRecord {
  readonly app: string;
  readonly sha: string;
  readonly mode: string;
  readonly status: string;
  readonly verdict?: string | undefined;
  readonly parentRunId?: string | undefined;
  readonly specs?: ReadonlyArray<Pick<SpecRecord, "name">> | undefined;
  readonly cases: ReadonlyArray<Pick<QaCase, "name" | "status" | "file">>;
  /* When the run record was written, ISO-8601. */
  readonly at: string;
}

/* A spec the run kept a snapshot of; `delivered` is 1 when the run delivered it. */
export interface EvidenceSpecSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
  /* Epoch ms. */
  readonly capturedAt: number;
  readonly delivered: number;
}

export interface EvidenceAgentTurn {
  readonly role: string;
  readonly toolSequence?: ReadonlyArray<{ tool: string; target: string | null }> | null | undefined;
  readonly promptProvidedReadCount?: number | null | undefined;
  readonly pathProvidedReadCount?: number | null | undefined;
}

/* What the run stored about how it ended (the columns grading reads, never recomputed from the app's current configuration). */
export interface EvidenceRunFacts {
  readonly cancelled: boolean | null;
  readonly decision: string | null;
  readonly reviewRequired: boolean | null;
  readonly coverageStatus: string | null;
  readonly coverageMode: string | null;
  readonly limitFired: string | null;
  readonly limitRole: string | null;
  readonly limits: ReadonlyArray<{ fired: string; role: string; scope: "run" | "turn" }> | null;
}

export type EvidenceRunOutcome = Pick<RunOutcome, "errorClass" | "gateSignals" | "adjudication" | "at">;

export interface EvidenceSources {
  readonly runId: string;
  readonly record: EvidenceRunRecord;
  readonly phases: { readonly furthestPhase: string | null } | undefined;
  readonly facts: EvidenceRunFacts | undefined;
  readonly outcome: EvidenceRunOutcome | undefined;
  readonly spans: readonly LedgerSpan[];
  readonly turns: readonly EvidenceAgentTurn[];
  readonly snapshots: readonly EvidenceSpecSnapshot[];
  /* The plan the run kept, as JSON. */
  readonly plan: string | undefined;
}
