/* The workspace handle is the only authority publication, confinement and gc act on: it names the spec directory and the kind and
   nothing else, the mirror root, the commit and the target stay in the registry that issued it, and a handle no registry of this run
   issued is refused before any git write is reached.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkspaceHandle } from "@contexts/workspace-and-publication/application/index.ts";
import { Sha } from "@kernel/sha.ts";
import { PublicationPortAdapter } from "@contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter.ts";
import { WorkspacePortAdapter } from "@contexts/workspace-and-publication/infrastructure/adapters/workspace-port.adapter.ts";
import { WorkspaceRegistry } from "@contexts/workspace-and-publication/infrastructure/adapters/workspace-registry.ts";
import { ConfinementPortAdapter } from "@contexts/workspace-and-publication/infrastructure/adapters/confinement-port.adapter.ts";
import { MirrorGcPortAdapter } from "@contexts/workspace-and-publication/infrastructure/adapters/mirror-gc-port.adapter.ts";
import { PublishDecisionService } from "@contexts/workspace-and-publication/domain/publish-decision.service.ts";

const MIRROR = "/mirrors/org/app";

function rig(opts: { isCode?: boolean } = {}) {
  const registry = new WorkspaceRegistry();
  const isCode = opts.isCode ?? false;
  const workspace = new WorkspacePortAdapter(async () => MIRROR, { specRelDir: isCode ? "" : "e2e", isCode }, registry);
  const written: Array<{ mirrorDir: string; branch: string; sha: string }> = [];
  const opened: string[] = [];
  const publication = new PublicationPortAdapter(
    {
      decide: new PublishDecisionService(),
      pr: { openWithAutoMerge: async () => { opened.push("pr"); return { url: "https://github.com/org/app/pull/1", number: 1 }; } },
      issue: { open: async () => ({ url: "https://github.com/org/app/issues/1", number: 1 }) },
      shadowLog: { openPr: async () => {} },
      render: { issue: () => "issue-body", prBody: () => "pr-body" },
      sanitize: (text) => text,
      vcsWrite: { publish: async (input) => { written.push(input); return { changed: true }; } },
    },
    { repo: "org/app", branch: "qa-bot/abc1234", reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true },
    registry,
  );
  return { registry, workspace, publication, written, opened };
}

const GREEN = { verdict: "pass", cases: [], logs: "" } as const;

test("prepare() returns a handle whose keys are exactly specDir and kind, with no symbol or mirror path on it", async () => {
  const { workspace } = rig();

  const handle = await workspace.prepare(Sha.of("abc1234"));

  assert.deepEqual(Object.keys(handle).sort(), ["kind", "specDir"]);
  assert.deepEqual(Object.getOwnPropertySymbols(handle), []);
  assert.equal(handle.specDir, `${MIRROR}/e2e`);
  assert.equal(handle.kind, "e2e");
  assert.equal(JSON.stringify(handle).includes("mirrors/org/app\""), false, "the mirror root is not serialisable from the handle");
});

test("a code workspace is a code handle", async () => {
  const { workspace } = rig({ isCode: true });
  assert.equal((await workspace.prepare(Sha.of("abc1234"))).kind, "code");
});

test("publishing with the handle reaches the git write with the real mirror directory and this run's commit", async () => {
  const { workspace, publication, written, opened } = rig();
  const handle = await workspace.prepare(Sha.of("abc1234"));

  const result = await publication.publish({ ...GREEN, workspace: handle });

  assert.match(result.outcome, /^pr:/);
  assert.deepEqual(written, [{ mirrorDir: MIRROR, branch: "qa-bot/abc1234", sha: "abc1234" }]);
  assert.deepEqual(opened, ["pr"]);
});

test("a handle from another run's registry is refused and nothing is written or opened", async () => {
  const { publication, written, opened } = rig();
  const foreign = await rig().workspace.prepare(Sha.of("abc1234"));

  await assert.rejects(() => publication.publish({ ...GREEN, workspace: foreign }), /not issued by this registry/);

  assert.deepEqual([written, opened], [[], []]);
});

test("an object built by the caller is not a handle: it is refused on every route", async () => {
  const { publication, written } = rig();
  const forged: WorkspaceHandle = { specDir: `${MIRROR}/e2e`, kind: "e2e" };

  await assert.rejects(() => publication.publish({ ...GREEN, workspace: forged }), /not issued by this registry/);
  await assert.rejects(() => publication.publish({ verdict: "invalid", cases: [], logs: "", workspace: forged }), /not issued by this registry/);

  assert.deepEqual(written, []);
});

test("the 'pr' route without a workspace fails closed", async () => {
  const { publication, written } = rig();

  await assert.rejects(() => publication.publish({ ...GREEN }), /requires decision\.workspace/);

  assert.deepEqual(written, []);
});

test("confinement and gc act on the mirror and target the handle stands for", async () => {
  const { registry, workspace } = rig({ isCode: true });
  const enforced: Array<{ mirrorDir: string; isCode: boolean }> = [];
  const pruned: string[] = [];
  const confinement = new ConfinementPortAdapter(registry, { enforce: async (mirrorDir, isCode) => { enforced.push({ mirrorDir, isCode }); return { strays: 0, dangerous: 0, reverted: [] }; } });
  const gc = new MirrorGcPortAdapter(registry, { prune: async (mirrorDir) => { pruned.push(mirrorDir); } });
  const handle = await workspace.prepare(Sha.of("abc1234"));

  await confinement.enforce(handle);
  await gc.prune(handle);

  assert.deepEqual(enforced, [{ mirrorDir: MIRROR, isCode: true }]);
  assert.deepEqual(pruned, [MIRROR]);
});

test("confinement and gc refuse a handle their registry did not issue, before touching any directory", async () => {
  const { registry } = rig();
  const calls: string[] = [];
  const confinement = new ConfinementPortAdapter(registry, { enforce: async () => { calls.push("enforce"); return { strays: 0, dangerous: 0, reverted: [] }; } });
  const gc = new MirrorGcPortAdapter(registry, { prune: async () => { calls.push("prune"); } });
  const foreign = await rig().workspace.prepare(Sha.of("abc1234"));

  await assert.rejects(() => confinement.enforce(foreign), /not issued by this registry/);
  await assert.rejects(() => gc.prune(foreign), /not issued by this registry/);

  assert.deepEqual(calls, []);
});
