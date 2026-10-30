/*
 * The shell's side of the run deadline's reserve: the phases of an app's recent runs, read from the run history and checked on the
 * way in (a stored row is data, so a phase name the engine does not know or a figure that is not a number is left out).
 */
import { RUN_PHASES, type RunPhase } from "../../qa-engine/src/shared-kernel/run-step";
import type { RunMode } from "../../qa-engine/src/shared-kernel/run-mode";
import type { PhaseHistoryPort, PhaseRecord } from "../../qa-engine/src/contexts/run-orchestration/application/index";

export interface StoredPhaseRecord {
  furthestPhase: string | null;
  phaseTimings: Record<string, number>;
}

const isPhase = (name: string): name is RunPhase => (RUN_PHASES as readonly string[]).includes(name);

export function phaseRecordOf(row: StoredPhaseRecord): PhaseRecord {
  const phaseTimings: Partial<Record<RunPhase, number>> = {};
  for (const [name, ms] of Object.entries(row.phaseTimings)) if (isPhase(name) && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) phaseTimings[name] = ms;
  return { furthestPhase: row.furthestPhase !== null && isPhase(row.furthestPhase) ? row.furthestPhase : null, phaseTimings };
}

export function historyPhaseHistory(read: (app: string, mode: RunMode, limit: number) => readonly StoredPhaseRecord[]): PhaseHistoryPort {
  return { recentPhaseRecords: async ({ app, mode, limit }) => read(app, mode, limit).map(phaseRecordOf) };
}
