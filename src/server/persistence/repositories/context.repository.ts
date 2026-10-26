import type { ArchitectureContext } from "@contexts/generation/application/index.ts";
import { logJson } from "../../../integrations/logger";
import { RedactionPortAdapter } from "../../../orchestrator/sanitizer";
import type { HistoryDatabase } from "../database";

const redactionPort = new RedactionPortAdapter();

export interface StoredContextMap {
  builtAtSha: string;
  data: ArchitectureContext;
  updatedAt: string;
}

/* The architecture-map flags and the stored map, per app: context_stale, context_heal_requests and context_maps. */
export class ContextRepository {
  private readonly markStale;
  private readonly isStale;
  private readonly clearStale;
  private readonly recordHealRequest;
  private readonly saveMap;
  private readonly loadMap;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.markStale = raw.prepare("INSERT OR REPLACE INTO context_stale (app, at) VALUES (?, ?)");
    this.isStale = raw.prepare("SELECT app FROM context_stale WHERE app = ?");
    this.clearStale = raw.prepare("DELETE FROM context_stale WHERE app = ?");
    this.recordHealRequest = raw.prepare("INSERT OR REPLACE INTO context_heal_requests (app, at) VALUES (?, ?)");
    this.saveMap = raw.prepare(
      "INSERT INTO context_maps (app, built_at_sha, data, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(app) DO UPDATE SET built_at_sha = excluded.built_at_sha, data = excluded.data, updated_at = excluded.updated_at",
    );
    this.loadMap = raw.prepare("SELECT built_at_sha, data, updated_at FROM context_maps WHERE app = ?");
  }

  /* Arms the one-shot "rebuild the architecture map next run" flag. */
  markContextStale(app: string): void {
    this.db.write(() => this.markStale.run(app, new Date().toISOString()));
  }

  /* Whether the app's architecture map is marked stale. Read-only: the flag stays armed. */
  isContextStale(app: string): boolean {
    return this.isStale.get(app) !== undefined;
  }

  /* Disarms the staleness flag: a rebuild was accepted by the queue, or a context run stored a fresh map. */
  clearContextStale(app: string): void {
    this.db.write(() => this.clearStale.run(app));
  }

  /* Records that an off-path rebuild was requested now. Idempotent: the latest request wins. */
  recordContextHealRequest(app: string): void {
    this.db.write(() => this.recordHealRequest.run(app, new Date().toISOString()));
  }

  /*
   * Persists the app's FE<->BE architecture map (per-app row; latest wins). `builtAtSha` is the deterministic run sha the orchestrator
   * captured this map at, not necessarily identical to `data.builtAtSha` (the agent's own self-reported field inside the JSON).
   */
  saveContextMap(app: string, builtAtSha: string, data: ArchitectureContext): void {
    this.db.write(() => this.saveMap.run(app, builtAtSha, JSON.stringify(data), new Date().toISOString()));
  }

  /*
   * A corrupt row (exists but fails to parse) is logged loudly and treated as "no stored map", never crashing a run: a context map is
   * advisory grounding, so undefined is the single "no usable stored map" signal for both cases.
   */
  loadContextMap(app: string): StoredContextMap | undefined {
    const row = this.loadMap.get(app) as { built_at_sha: string; data: string; updated_at: string } | undefined;
    if (!row) return undefined;
    try {
      return { builtAtSha: row.built_at_sha, data: JSON.parse(row.data) as ArchitectureContext, updatedAt: row.updated_at };
    } catch (err) {
      logJson("warn", `corrupt context-map row for app '${app}' — treating as no stored map`, {
        app,
        error: redactionPort.redactError(err),
      });
      return undefined;
    }
  }
}
