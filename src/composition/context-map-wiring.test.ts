/* The composition root's wiring of the context-map rebuild question (runner.ts, RunnerDeps.contextMapNeedsRebuild); the rule itself is the engine's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMapNeedsRebuildFor } from "./context-map-wiring";

test("the wiring answers the engine's question over the ports it is given", async () => {
  const synced: string[] = [];
  const ask = contextMapNeedsRebuildFor({
    loadApp: () => ({ repo: "org/demo" }),
    loadStoredMap: () => ({ builtAtSha: "aaaa111", data: { routes: [], api: [], feBe: [] } }),
    isStale: () => false,
    syncMirror: async (repo, sha) => { synced.push(`${repo}@${sha}`); return "/mirrors/org__demo"; },
    changesBetween: () => [],
  });
  assert.equal(await ask("demo", "bbbb222"), false);
  assert.deepEqual(synced, ["org/demo@bbbb222"]);
  assert.equal(await contextMapNeedsRebuildFor({ loadApp: () => ({ repo: "org/demo" }), loadStoredMap: () => undefined, isStale: () => false, syncMirror: async () => "", changesBetween: () => [] })("demo", "bbbb222"), true);
});
