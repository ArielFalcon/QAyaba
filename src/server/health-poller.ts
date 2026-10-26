/* The service's periodic self-check, once a minute: probes its own liveness endpoint, sweeps orphaned agent sessions, raises incidents for a failing probe or a deep queue, hands pending incidents to the maintainer, and runs the slow jobs on their own tick counts (history retention and the SQLite backup every 24 hours, the mirror prune every 6 hours). */

export interface HealthPollerDeps {
  /* The port the control plane listens on: the probe is `http://localhost:<port>/api/health`. */
  port: number;
  fetch(url: string): Promise<{ ok: boolean; status: number }>;
  queueSize(): number;
  recordIncident(incident: { source: "health-check"; severity: "warn" | "critical"; summary: string }): void;
  hasPendingIncidents(): boolean;
  maintainerIdle(): boolean;
  triggerMaintainer(): void;
  cleanupOrphanedSessions(): Promise<void>;
  /* Deletes the history the retention windows no longer keep. Logs its own failure. */
  runHistoryRetention(): void;
  backupDatabase(): Promise<{ backedUp: boolean; path?: string; error?: string }>;
  pruneMirrors(): void;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  /* Runs `tick` every `intervalMs`; the default is setInterval. */
  schedule?(tick: () => Promise<void>, intervalMs: number): unknown;
}

export const HEALTH_POLL_INTERVAL_MS = 60_000;
/* 24 hours at one tick a minute. */
export const BACKUP_INTERVAL_TICKS = 1440;
/* 6 hours at one tick a minute. */
export const PRUNE_INTERVAL_TICKS = 360;
const DEEP_QUEUE = 10;

export function startHealthPoller(deps: HealthPollerDeps): void {
  let fails = 0;
  let lastQueueWarn = 0;
  let backupTick = 0;
  let pruneTick = 0;
  const schedule = deps.schedule ?? ((tick, intervalMs) => setInterval(() => void tick(), intervalMs));

  schedule(async () => {
    try {
      const res = await deps.fetch(`http://localhost:${deps.port}/api/health`);
      if (!res.ok) throw new Error(`health probe returned ${res.status}`);
      fails = 0;
    } catch {
      fails++;
      if (fails === 3) {
        deps.recordIncident({ source: "health-check", severity: "critical", summary: "orchestrator health check failing (3 consecutive failures)" });
      }
      if (fails === 10) {
        deps.recordIncident({ source: "health-check", severity: "critical", summary: "orchestrator health check failing (10 consecutive failures — likely crashed)" });
      }
    }
    await deps.cleanupOrphanedSessions();
    const depth = deps.queueSize();
    if (depth > DEEP_QUEUE && lastQueueWarn <= DEEP_QUEUE) {
      deps.recordIncident({ source: "health-check", severity: "warn", summary: `queue depth is ${depth} (possible stuck job)` });
    }
    lastQueueWarn = depth;

    if (deps.hasPendingIncidents() && deps.maintainerIdle()) {
      deps.triggerMaintainer();
    }

    backupTick++;
    if (backupTick >= BACKUP_INTERVAL_TICKS) {
      backupTick = 0;
      deps.runHistoryRetention();
      const r = await deps.backupDatabase();
      if (r.backedUp) {
        deps.log("info", "SQLite backup created", { path: r.path });
      } else if (r.error) {
        deps.log("warn", "SQLite backup failed", { error: r.error });
      }
    }

    pruneTick++;
    if (pruneTick >= PRUNE_INTERVAL_TICKS) {
      pruneTick = 0;
      deps.pruneMirrors();
    }
  }, HEALTH_POLL_INTERVAL_MS);
}
