/* The question behind the context-map rebuild before a run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMapNeedsRebuild, type ContextMapRebuildPorts } from "@contexts/run-orchestration/application/context-map-rebuild.ts";
import type { ChangedFile } from "@contexts/run-orchestration/domain/context-map-validity.ts";

const BUILT = "aaaa111";
const RUN = "bbbb222";
const MAP = { builtAtSha: BUILT, data: { routes: [{ path: "/shops", source: "src/shops.routes.ts", implementationFiles: ["src/shops/shops.page.ts"] }], api: [], feBe: [] } };

function rig(over: Partial<ContextMapRebuildPorts> & { changes?: ChangedFile[] | undefined } = {}) {
  const synced: string[] = [];
  const ports: ContextMapRebuildPorts = {
    loadApp: over.loadApp ?? (() => ({ repo: "org/demo" })),
    loadStoredMap: over.loadStoredMap ?? (() => MAP),
    isStale: over.isStale ?? (() => false),
    syncMirror: over.syncMirror ?? (async (repo, sha) => { synced.push(`${repo}@${sha}`); return "/mirrors/org__demo"; }),
    changesBetween: over.changesBetween ?? (() => ("changes" in over ? over.changes : [])),
  };
  return { ask: contextMapNeedsRebuild(ports), synced };
}

test("a map built at the run's commit, or whose named files did not change, needs no rebuild", async () => {
  assert.equal(await rig({ loadStoredMap: () => ({ ...MAP, builtAtSha: RUN }) }).ask("demo", RUN), false);
  const modifiedPage = rig({ changes: [{ status: "M", path: "src/shops/shops.page.ts" }] });
  assert.equal(await modifiedPage.ask("demo", RUN), false);
  assert.deepEqual(modifiedPage.synced, ["org/demo@bbbb222"], "the comparison reads the mirror at the run's commit");
});

test("a missing map, a map marked stale, a changed route declaration or commits that cannot be compared need a rebuild", async () => {
  assert.equal(await rig({ loadStoredMap: () => undefined }).ask("demo", RUN), true);
  assert.equal(await rig({ isStale: () => true }).ask("demo", RUN), true);
  assert.equal(await rig({ changes: [{ status: "M", path: "src/shops.routes.ts" }] }).ask("demo", RUN), true);
  assert.equal(await rig({ changes: undefined }).ask("demo", RUN), true);
  const unsafe = rig({ loadStoredMap: () => ({ ...MAP, builtAtSha: "--output=/tmp/x" }) });
  assert.equal(await unsafe.ask("demo", RUN), true, "a recorded commit that is not a sha is never handed to git");
  assert.deepEqual(unsafe.synced, []);
});

test("a map marked stale needs a rebuild even at the run's own commit", async () => {
  assert.equal(await rig({ loadStoredMap: () => ({ ...MAP, builtAtSha: RUN }), isStale: () => true }).ask("demo", RUN), true);
});

test("a map is rebuilt when a page's implementation file is gone, and not when only a page was added", async () => {
  assert.equal(await rig({ changes: [{ status: "D", path: "src/shops/shops.page.ts" }] }).ask("demo", RUN), true);
  assert.equal(await rig({ changes: [{ status: "A", path: "src/extra.page.ts" }] }).ask("demo", RUN), false);
});
