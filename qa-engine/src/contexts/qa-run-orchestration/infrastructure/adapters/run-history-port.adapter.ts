/* RunHistoryPort: save-only. In-memory for process lifetime; file adapter appends JSONL. */

import { appendFileSync } from "node:fs";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunHistoryPort } from "../../application/ports/index.ts";

/* Process-lifetime store — no persistence across restarts. Prefer FileRunHistoryAdapter when outcomes must survive a restart. */
export class InMemoryRunHistoryAdapter implements RunHistoryPort {
  private readonly outcomes: RunOutcome[] = [];

  async save(outcome: RunOutcome): Promise<void> {
    this.outcomes.push(outcome);
  }

  /* Read-back for callers that need accumulated history. Not part of RunHistoryPort (save-only). */
  list(): readonly RunOutcome[] {
    return this.outcomes;
  }
}

/* Durable append-only JSONL — one outcome per line. FS write errors propagate loudly. */
export class FileRunHistoryAdapter implements RunHistoryPort {
  constructor(private readonly filePath: string) {}

  async save(outcome: RunOutcome): Promise<void> {
    appendFileSync(this.filePath, `${JSON.stringify(outcome)}\n`, "utf8");
  }
}
