/* There is NO "mirror prepare"/checkout concept under workspace-and-publication/
   (MirrorRegistryPort resolves repo->dir only; MirrorGcPort only prunes an EXISTING mirror). This
   adapter injects a checkout primitive (argv/paths live in the adapter, the actual git/fs call is
   injected so the test needs no real git binary). Cross-repo routing stays OPAQUE inside this
   adapter — the injected checkout fn receives only sha + the static repo/specRelDir context; the
   composition root decides which mirror. The spec directory is
   `${mirrorDir}/${specRelDir}`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePortAdapter } from "@contexts/workspace-and-publication/infrastructure/adapters/workspace-port.adapter.ts";
import { WorkspaceRegistry } from "@contexts/workspace-and-publication/infrastructure/adapters/workspace-registry.ts";
import { Sha } from "@kernel/sha.ts";

test("prepare() delegates to the injected checkout collaborator and derives specDir from mirrorDir + specRelDir", async () => {
  let capturedSha: Sha | undefined;
  const checkout = async (sha: Sha): Promise<string> => {
    capturedSha = sha;
    return "/mirrors/org/app";
  };
  const adapter = new WorkspacePortAdapter(checkout, { specRelDir: "e2e" }, new WorkspaceRegistry());

  const sha = Sha.of("abc1234");
  const result = await adapter.prepare(sha);

  assert.equal(capturedSha, sha);
  assert.equal(result.specDir, "/mirrors/org/app/e2e");
});

/* The mirror root is the publish pathspecs' base (they are relative to mirrorDir, never specDir): the adapter keeps it beside the
   handle it issues, readable only as the read-side roots. */

test("readRoots() gives the bare mirrorDir the checkout resolved BEFORE specRelDir is joined on", async () => {
  const checkout = async (): Promise<string> => "/mirrors/org/app";
  const adapter = new WorkspacePortAdapter(checkout, { specRelDir: "e2e" }, new WorkspaceRegistry());

  const roots = adapter.readRoots(await adapter.prepare(Sha.of("abc1234")));

  assert.deepEqual(roots, { mirrorDir: "/mirrors/org/app", specDir: "/mirrors/org/app/e2e" });
});

test("prepare() surfaces a checkout failure loudly", async () => {
  const checkout = async (): Promise<string> => { throw new Error("mirror clone failed: network unreachable"); };
  const adapter = new WorkspacePortAdapter(checkout, { specRelDir: "e2e" }, new WorkspaceRegistry());

  await assert.rejects(() => adapter.prepare(Sha.of("abc1234")), /mirror clone failed/);
});
