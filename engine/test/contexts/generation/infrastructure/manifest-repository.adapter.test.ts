import { test } from "node:test";
import assert from "node:assert/strict";
import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter.ts";
import type { SpecRoot } from "../../../../src/shared-infrastructure/spec-path-confinement.ts";

/* (the canonical @kernel/manifest/manifest-entry.ts shape) — every fixture below is updated to
   populate both, matching what every LIVE writer (generate-tests.use-case.ts's rawEntries) already does.
 */

test("read delegates to the injected manifest reader", async () => {
  let seenDir = "";
  const adapter = new ManifestRepositoryAdapter({
    readManifest: async (dir) => { seenDir = dir; return [{ id: "1", file: "e2e/a.spec.ts", flow: "login", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } }]; },
    reconcileManifest: async (_dir, entries) => [...entries],
  });
  const entries = await adapter.read("/m/e2e");
  assert.equal(seenDir, "/m/e2e");
  assert.equal(entries[0]?.id, "1");
});

test("reconcile delegates and forwards the on-disk-pruned entries", async () => {
  let called = false;
  const adapter = new ManifestRepositoryAdapter({
    readManifest: async () => [],
    reconcileManifest: async (_root, entries) => { called = true; return entries.filter((e) => e.id !== "stale"); },
  });
  const out = await adapter.reconcile({ mirrorDir: "/m", specDir: "/m/e2e" }, [
    { id: "1", file: "e2e/a.spec.ts", flow: "f", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    { id: "stale", file: "e2e/x.spec.ts", flow: "f", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
  ]);
  assert.equal(called, true);
  assert.deepEqual(out.map((e) => e.id), ["1"]); /* stale entry pruned by the injected reconcile */
});

/* The files of a manifest are the agent's names: they are only ever resolved against the spec root of the run, never a bare directory, so the injected reconcile must receive the whole root, mirror included. */
test("reconcile hands the injected reconcile the whole spec root, the mirror as well as the spec directory", async () => {
  const seen: SpecRoot[] = [];
  const adapter = new ManifestRepositoryAdapter({
    readManifest: async () => [],
    reconcileManifest: async (root, entries) => { seen.push(root); return [...entries]; },
  });
  await adapter.reconcile({ mirrorDir: "/m", specDir: "/m/e2e" }, []);
  await adapter.reconcile({ mirrorDir: "/work/app", specDir: "/work/app" }, []);
  assert.deepEqual(seen, [
    { mirrorDir: "/m", specDir: "/m/e2e" },
    { mirrorDir: "/work/app", specDir: "/work/app" },
  ]);
});
