import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { qayabaDataDir } from "../../paths";
import { RedactionPortAdapter } from "../../orchestrator/sanitizer";
import type { HistoryDatabase } from "./database";

const redactionPort = new RedactionPortAdapter();

/* Backups kept in the data directory; older ones are removed. */
const BACKUPS_KEPT = 7;

/*
 * Online snapshot of the history database into `<data>/backups/`, using better-sqlite3's native backup API: WAL-safe, unlike a raw
 * file copy, which can miss the -wal tail and produce a torn backup. Called from the health poller every 24h.
 */
export async function backupDatabase(db: HistoryDatabase): Promise<{ backedUp: boolean; path?: string; error?: string }> {
  const backupDir = join(qayabaDataDir(), "backups");
  try {
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(backupDir, `qayaba-${timestamp}.db`);
    await db.raw.backup(backupPath);
    const files = readdirSync(backupDir)
      .filter((f: string) => f.startsWith("qayaba-") && f.endsWith(".db"))
      .sort();
    while (files.length > BACKUPS_KEPT) {
      const old = files.shift();
      if (old) unlinkSync(join(backupDir, old));
    }
    return { backedUp: true, path: backupPath };
  } catch (err) {
    return { backedUp: false, error: redactionPort.redactError(err) };
  }
}
