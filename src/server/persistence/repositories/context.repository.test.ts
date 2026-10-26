import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ArchitectureContext } from "@contexts/generation/application/index.ts";
import { getHistory } from "../index";

test("a marked context-stale flag stays armed across reads until it is cleared", () => {
  const app = "hist-ctx-stale";
  assert.equal(getHistory().contexts.isContextStale(app), false);
  getHistory().contexts.markContextStale(app);
  assert.equal(getHistory().contexts.isContextStale(app), true);
  assert.equal(getHistory().contexts.isContextStale(app), true, "reading the flag must not disarm it");
  getHistory().contexts.clearContextStale(app);
  assert.equal(getHistory().contexts.isContextStale(app), false);
});

/* ── context_maps (the persisted FE<->BE architecture map from mode:context runs) ────────── */

test("saveContextMap/loadContextMap round-trip per app; latest save wins; a corrupt row is logged loudly and treated as absent, never crashes", () => {
  const app = `hist-ctxmap-${Date.now().toString(36)}`;
  assert.equal(getHistory().contexts.loadContextMap(app), undefined, "no row yet");

  const map1: ArchitectureContext = { builtAtSha: "sha1", routes: [{ path: "/a" }], api: [], feBe: [] };
  getHistory().contexts.saveContextMap(app, "sha1", map1);
  const stored1 = getHistory().contexts.loadContextMap(app);
  assert.ok(stored1, "sanity: the valid row round-trips");
  assert.equal(stored1!.builtAtSha, "sha1");
  assert.deepEqual(stored1!.data, map1);
  assert.equal(typeof stored1!.updatedAt, "string");

  /* Latest save wins (per-app row, not append-only). */
  const map2: ArchitectureContext = { builtAtSha: "sha2", routes: [], api: [], feBe: [] };
  getHistory().contexts.saveContextMap(app, "sha2", map2);
  const stored2 = getHistory().contexts.loadContextMap(app);
  assert.equal(stored2!.builtAtSha, "sha2");
  assert.deepEqual(stored2!.data, map2);

  /* Corrupt the row directly (bypassing saveContextMap, which only ever writes valid JSON) — a
     second connection to the SAME on-disk db (WAL mode allows this), same technique loadCurriculum's
     own corrupt-row test above uses. */
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "qayaba.db");
  const raw = new Database(dbPath);
  try {
    raw.prepare("UPDATE context_maps SET data = ? WHERE app = ?").run("{not valid json", app);
  } finally {
    raw.close();
  }

  const originalWarn = console.warn;
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const result = getHistory().contexts.loadContextMap(app);
    assert.equal(result, undefined, "a corrupt row must degrade to 'no stored map' — never crash a run");
    assert.equal(logged.length, 1, "the corrupt row must be logged exactly once, not swallowed silently");
    assert.match(logged[0] ?? "", /corrupt/i, "the log line must be identifiable as a corrupt context-map fault");
    assert.match(logged[0] ?? "", new RegExp(app), "the log line must identify which app's row is corrupt");
  } finally {
    console.warn = originalWarn;
  }
});
