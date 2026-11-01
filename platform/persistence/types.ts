

import { parseRunMode, RUN_MODES, type RunMode, type TestTarget, type TriggerSource } from "@kernel/run-mode";
import { RUN_ENGINE_STATUSES, engineStatus, type RunEngineStatus, type RunVerdict } from "@kernel/run-verdict";
import type { CaseStatus, QaCase, SpecRecord } from "@kernel/qa-case";
import type { RunOutcome as EngineRunOutcome } from "@kernel/run-outcome";
import type { ActivityKind } from "@kernel/activity-kind";
import type { ChangeEntryRecord } from "@kernel/change-set";

export { parseRunMode, RUN_MODES, RUN_ENGINE_STATUSES, engineStatus };
export type { RunMode, TestTarget, TriggerSource, RunEngineStatus, RunVerdict, CaseStatus, QaCase };

export interface QaRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean;
  cases: QaCase[];
  logs: string;
  note?: string;  /* human-readable summary of what happened (reviewer rejection, skip reason, etc.) */
  outcome?: string;  /* what the run PRODUCED — "suite PR merged · <url>", "Issue filed · <url>", etc. */
}

/*
 * A structured, real-time activity event for the TUI. `kind` (and `status` for todos) lets the
 * dashboard categorize a live panel. Raw model-stream prose is never an activity.
 */
export type { ActivityKind };

export interface AgentActivity {
  kind: ActivityKind;
  text: string;              /* already clean: file basename, full command, or todo content */
  status?: "pending" | "in_progress" | "completed";  /* todos only */
  ts: string;                /* ISO timestamp — for ordering and elapsed */
}

/* Full run history record persisted in SQLite (platform/persistence/repositories/run.repository.ts). */
export type RunChangeEntry = ChangeEntryRecord;

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

export type { ErrorClass } from "@kernel/error-class";

/*
 * The outcome the history store keeps: the engine's own record without what the store does not hold (the note, the cases and
 * the logs live on the run record). Derived, so a field the engine adds reaches the store's
 * type without a second declaration. The engine keeps `errorClass` and `usage` wide so it imports nothing downstream; a reader
 * that needs the narrow `ErrorClass` or `RunUsage` narrows at its read.
 */
export type RunOutcome = Omit<EngineRunOutcome, "note" | "cases" | "logs">;
