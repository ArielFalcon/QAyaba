
import type { RunHistoryPort } from "@contexts/run-orchestration/application/index.ts";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as StoredRunOutcome } from "../types";
import { getHistory } from "./persistence/index";

/*
 * Dependency injection is the testing strategy (AGENTS.md): a test supplies a fake saveOutcome so
 * the adapter is verifiable without touching the real (lazily-initialized, module-singleton)
 * SQLite database the history repositories own.
 */
export interface RunHistorySqliteAdapterDeps {
  saveOutcome: (outcome: StoredRunOutcome) => void;
}

export const defaultRunHistorySqliteAdapterDeps: RunHistorySqliteAdapterDeps = {
  saveOutcome: (outcome) => getHistory().learning.saveRunOutcome(outcome),
};

/* The store keeps the columns it names and ignores the rest of the engine's outcome (the note, the cases, the logs), so the outcome goes in as it is. */
export class SqliteRunHistoryAdapter implements RunHistoryPort {
  constructor(private readonly deps: RunHistorySqliteAdapterDeps = defaultRunHistorySqliteAdapterDeps) {}

  async save(outcome: KernelRunOutcome): Promise<void> {
    this.deps.saveOutcome(outcome);
  }
}
