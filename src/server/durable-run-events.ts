import type { RunEvent } from "../contract/events";
import { createRunEventStore, type RunEventStore } from "./run-events";
import { saveRunEvent as defaultSaveRunEvent, loadRunEvents as defaultLoadRunEvents } from "./history";

export interface DurableRunEventDeps {
  saveRunEvent?: (event: { runId: string; seq: number; ts: number; body: unknown }) => void;
  loadRunEvents?: (runId: string, afterSeq: number) => Array<{ runId: string; seq: number; ts: number; body: unknown }>;
}

/*
 * Shared durable run-event store for every trigger that owns a queue (long-lived server and
 * manual CLI). CLI and server persist identically so the TUI can replay and tail a CLI run.
 */
export function createDurableRunEventStore(deps: DurableRunEventDeps = {}): RunEventStore {
  const save = deps.saveRunEvent ?? defaultSaveRunEvent;
  const load = deps.loadRunEvents ?? defaultLoadRunEvents;
  return createRunEventStore({
    persist: (e) => save({ runId: e.runId, seq: e.seq, ts: e.ts, body: e.body }),
    loadPersisted: (runId, afterSeq) =>
      load(runId, afterSeq).map((r) => ({ seq: r.seq, runId: r.runId, ts: r.ts, body: r.body }) as RunEvent),
  });
}
