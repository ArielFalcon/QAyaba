import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_INTERVAL_TICKS, HEALTH_POLL_INTERVAL_MS, PRUNE_INTERVAL_TICKS, startHealthPoller, type HealthPollerDeps } from "./health-poller";

function harness(over: Partial<HealthPollerDeps> = {}) {
  const incidents: Array<{ severity: string; summary: string }> = [];
  const log: string[] = [];
  const calls = { retention: 0, backup: 0, prune: 0, maintainer: 0, orphans: 0 };
  let tick: (() => Promise<void>) | undefined;
  let interval = 0;
  const deps: HealthPollerDeps = {
    port: 4500,
    fetch: async () => ({ ok: true, status: 200 }),
    queueSize: () => 0,
    recordIncident: (incident) => incidents.push(incident),
    hasPendingIncidents: () => false,
    maintainerIdle: () => true,
    triggerMaintainer: () => { calls.maintainer++; },
    cleanupOrphanedSessions: async () => { calls.orphans++; },
    runHistoryRetention: () => { calls.retention++; },
    backupDatabase: async () => { calls.backup++; return { backedUp: true, path: "/backups/x.db" }; },
    pruneMirrors: () => { calls.prune++; },
    log: (_level, message) => log.push(message),
    schedule: (fn, ms) => { tick = fn; interval = ms; },
    ...over,
  };
  startHealthPoller(deps);
  return { run: async (times = 1) => { for (let i = 0; i < times; i++) await tick!(); }, incidents, log, calls, interval: () => interval };
}

test("the poll runs once a minute", () => {
  assert.equal(harness().interval(), HEALTH_POLL_INTERVAL_MS);
});

test("the probe names the service's own health endpoint on the configured port", async () => {
  const urls: string[] = [];
  const h = harness({ fetch: async (url) => { urls.push(url); return { ok: true, status: 200 }; } });
  await h.run();
  assert.equal(urls[0], "http://localhost:4500/api/health");
});

test("three consecutive failed probes raise one critical incident and ten raise a second", async () => {
  const h = harness({ fetch: async () => ({ ok: false, status: 503 }) });
  await h.run(2);
  assert.equal(h.incidents.length, 0);
  await h.run(1);
  assert.equal(h.incidents.length, 1);
  assert.equal(h.incidents[0]?.severity, "critical");
  await h.run(7);
  assert.equal(h.incidents.length, 2);
});

test("a probe that recovers resets the failure count", async () => {
  let up = false;
  const h = harness({ fetch: async () => ({ ok: up, status: up ? 200 : 503 }) });
  await h.run(2);
  up = true;
  await h.run(1);
  up = false;
  await h.run(2);
  assert.equal(h.incidents.length, 0);
});

test("a queue deeper than ten raises one warning until it drains", async () => {
  let depth = 11;
  const h = harness({ queueSize: () => depth });
  await h.run(3);
  assert.equal(h.incidents.filter((incident) => incident.severity === "warn").length, 1);
  depth = 0;
  await h.run(1);
  depth = 12;
  await h.run(1);
  assert.equal(h.incidents.filter((incident) => incident.severity === "warn").length, 2);
});

test("pending incidents reach the maintainer only while it is idle", async () => {
  let idle = false;
  const h = harness({ hasPendingIncidents: () => true, maintainerIdle: () => idle });
  await h.run();
  assert.equal(h.calls.maintainer, 0);
  idle = true;
  await h.run();
  assert.equal(h.calls.maintainer, 1);
});

test("history retention and the backup run on the 24 hour tick and nowhere before it", async () => {
  const h = harness();
  await h.run(BACKUP_INTERVAL_TICKS - 1);
  assert.equal(h.calls.retention, 0);
  assert.equal(h.calls.backup, 0);
  await h.run(1);
  assert.equal(h.calls.retention, 1);
  assert.equal(h.calls.backup, 1);
  assert.ok(h.log.some((line) => line.includes("backup created")));
});

test("a failed backup is logged and the poll goes on", async () => {
  const h = harness({ backupDatabase: async () => ({ backedUp: false, error: "disk full" }) });
  await h.run(BACKUP_INTERVAL_TICKS);
  assert.ok(h.log.some((line) => line.includes("backup failed")));
});

test("mirrors are pruned on the 6 hour tick", async () => {
  const h = harness();
  await h.run(PRUNE_INTERVAL_TICKS - 1);
  assert.equal(h.calls.prune, 0);
  await h.run(1);
  assert.equal(h.calls.prune, 1);
  await h.run(PRUNE_INTERVAL_TICKS);
  assert.equal(h.calls.prune, 2);
});

test("orphaned agent sessions are swept on every tick", async () => {
  const h = harness();
  await h.run(3);
  assert.equal(h.calls.orphans, 3);
});
