/*
 * The shell's side of the run deadline's reserve: the phases of an app's recent runs, read from the run history and checked on the
 * way in (a stored row is data, so a phase name the engine does not know or a figure that is not a number is left out).
 */
import { DEADLINE_PURPOSES, type DeadlinePurpose } from "../../qa-engine/src/shared-kernel/deadline-purpose";
import { RUN_PHASES, type RunPhase } from "../../qa-engine/src/shared-kernel/run-step";
import type { PhaseHistoryPort, PhaseRecord, RunTimeBudgetKey } from "../../qa-engine/src/contexts/run-orchestration/application/index";

export interface StoredPhaseRecord {
  furthestPhase: string | null;
  phaseTimings: Record<string, number>;
  /* The purposes the run's deadline or a share of it cut, as its limits stored them. */
  cutPurposes?: readonly string[];
}

const isPurpose = (name: string): name is DeadlinePurpose => (DEADLINE_PURPOSES as readonly string[]).includes(name);
const isPhase = (name: string): name is RunPhase => (RUN_PHASES as readonly string[]).includes(name);

export function phaseRecordOf(row: StoredPhaseRecord): PhaseRecord {
  const phaseTimings: Partial<Record<RunPhase, number>> = {};
  for (const [name, ms] of Object.entries(row.phaseTimings)) if (isPhase(name) && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) phaseTimings[name] = ms;
  const cutPurposes = (row.cutPurposes ?? []).filter(isPurpose);
  return { furthestPhase: row.furthestPhase !== null && isPhase(row.furthestPhase) ? row.furthestPhase : null, phaseTimings, ...(cutPurposes.length > 0 ? { cutPurposes } : {}) };
}

export function historyPhaseHistory(read: (app: string, budget: RunTimeBudgetKey, limit: number) => readonly StoredPhaseRecord[]): PhaseHistoryPort {
  return { recentPhaseRecords: async ({ app, budget, limit }) => read(app, budget, limit).map(phaseRecordOf) };
}
