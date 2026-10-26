/* The composition root's question behind the context-map rebuild before a run (runner.ts, RunnerDeps.contextMapNeedsRebuild). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMapNeedsRebuildFor, type ContextMapQuestionDeps } from "./context-map-wiring";
import type { AppConfig } from "../orchestrator/config-loader";
import type { ChangedFile } from "@contexts/run-orchestration/application/index";

const BUILT = "aaaa111";
const RUN = "bbbb222";
const app = (over: Partial<AppConfig> = {}): AppConfig => ({
  name: "demo",
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" },
  ...over,
});
const MAP = { builtAtSha: BUILT, routes: [{ path: "/shops", source: "src/shops.routes.ts", implementationFiles: ["src/shops/shops.page.ts"] }], api: [], feBe: [] };

function rig(over: Partial<ContextMapQuestionDeps> & { changes?: ChangedFile[] | undefined } = {}) {
  const synced: string[] = [];
  const deps: ContextMapQuestionDeps = {
    loadApp: over.loadApp ?? (() => app()),
    loadStoredMap: over.loadStoredMap ?? (() => ({ builtAtSha: BUILT, data: MAP, updatedAt: "2026-10-25T00:00:00Z" })),
    isStale: over.isStale ?? (() => false),
    syncMirror: over.syncMirror ?? (async (repo, sha) => { synced.push(`${repo}@${sha}`); return "/mirrors/org__demo"; }),
    changesBetween: over.changesBetween ?? (() => ("changes" in over ? over.changes : [])),
  };
  return { ask: contextMapNeedsRebuildFor({}, deps)!, synced };
}

test("a map built at the run's commit, or whose named files did not change, needs no rebuild", async () => {
  assert.equal(await rig({ loadStoredMap: () => ({ builtAtSha: RUN, data: MAP, updatedAt: "" }) }).ask("demo", RUN), false);
  const modifiedPage = rig({ changes: [{ status: "M", path: "src/shops/shops.page.ts" }] });
  assert.equal(await modifiedPage.ask("demo", RUN), false);
  assert.deepEqual(modifiedPage.synced, ["org/demo@bbbb222"], "the comparison reads the mirror at the run's commit");
});

test("a missing map, a map marked stale, a changed route declaration or commits that cannot be compared need a rebuild", async () => {
  assert.equal(await rig({ loadStoredMap: () => undefined }).ask("demo", RUN), true);
  assert.equal(await rig({ isStale: () => true }).ask("demo", RUN), true);
  assert.equal(await rig({ changes: [{ status: "M", path: "src/shops.routes.ts" }] }).ask("demo", RUN), true);
  assert.equal(await rig({ changes: undefined }).ask("demo", RUN), true);
  const unsafe = rig({ loadStoredMap: () => ({ builtAtSha: "--output=/tmp/x", data: MAP, updatedAt: "" }) });
  assert.equal(await unsafe.ask("demo", RUN), true, "a recorded commit that is not a sha is never handed to git");
  assert.deepEqual(unsafe.synced, []);
});

test("a code app never needs a map, and the campaign freeze wires no question", async () => {
  assert.equal(await rig({ loadApp: () => app({ code: true }) }).ask("demo", RUN), false);
  assert.equal(contextMapNeedsRebuildFor({ QA_CAMPAIGN_FREEZE: "true" }), undefined);
});
