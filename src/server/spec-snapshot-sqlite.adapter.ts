/* The shell's side of SpecSnapshotPort: the snapshots go into the run history's run_spec_snapshots table. Total: a fault is logged and the run goes on. */

import type { SpecSnapshot, SpecSnapshotPort } from "@kernel/ports/spec-snapshot.port";
import { getHistory } from "./persistence/index";
import type { SpecSnapshotRow } from "./persistence/repositories/run.repository";

export class SqliteSpecSnapshotAdapter implements SpecSnapshotPort {
  constructor(private readonly commit: (rows: readonly SpecSnapshotRow[]) => void = (rows) => getHistory().runs.commitSpecSnapshots(rows)) {}

  record(snapshots: readonly SpecSnapshot[]): void {
    try {
      this.commit(snapshots.map((s) => ({ runId: s.runId, path: s.path, sha256: s.sha256, text: s.text, bytes: s.bytes, capturedAt: s.capturedAt, delivered: s.delivered ? 1 : 0 })));
    } catch (err) {
      console.error(`[qa] spec snapshots could not be stored (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
