import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FsDelegationWorkspaceAdapter } from "@contexts/coordination/infrastructure/adapters/delegation-workspace.adapter.ts";
import { WORKSPACE_CHANGE, type DelegationWorkspaceRequest } from "@contexts/coordination/application/ports/delegation-workspace.port.ts";
import { MAX_SPEC_SOURCE_BYTES } from "../../../../../src/shared-infrastructure/spec-path-confinement.ts";

interface Fixture {
  base: string;
  mirrorDir: string;
  specDir: string;
  root: string;
  request: DelegationWorkspaceRequest;
}

function put(dir: string, rel: string, text: string | Buffer): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function withFixture(fn: (f: Fixture) => Promise<void> | void, over: Partial<DelegationWorkspaceRequest> = {}): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "qa-delegation-"));
  const mirrorDir = join(base, "mirror");
  const specDir = join(mirrorDir, "e2e");
  const root = join(base, ".qa-delegations");
  mkdirSync(specDir, { recursive: true });
  put(mirrorDir, "src/app.ts", "export const app = 1;\n");
  put(mirrorDir, "e2e/fixtures.ts", "export const test = 1;\n");
  put(mirrorDir, "e2e/flows/existing.spec.ts", "// existing\n");
  const request: DelegationWorkspaceRequest = {
    runId: "run-1",
    delegationId: "run-1-flow-login",
    mirrorDir,
    specDir,
    specRelDir: "e2e",
    writablePaths: ["e2e/flows/login.spec.ts"],
    ...over,
  };
  return Promise.resolve(fn({ base, mirrorDir, specDir, root, request })).finally(() => rmSync(base, { recursive: true, force: true }));
}

const adapterOf = (f: Fixture, limits?: ConstructorParameters<typeof FsDelegationWorkspaceAdapter>[0]["limits"]) =>
  new FsDelegationWorkspaceAdapter({ root: f.root, ...(limits ? { limits } : {}) });

test("the workspace holds a copy of what the run may read and nothing of what it must not", () =>
  withFixture(async (f) => {
    put(f.mirrorDir, "node_modules/pkg/index.js", "x");
    put(f.mirrorDir, ".git/config", "[core]");
    put(f.mirrorDir, "e2e/.auth/state.json", "{}");
    put(f.mirrorDir, ".env", "SECRET=1");
    put(f.mirrorDir, ".env.production", "SECRET=2");
    put(f.mirrorDir, "e2e/storageState.admin.json", "{}");
    put(f.mirrorDir, "e2e/test-results/trace.zip", "x");
    put(f.mirrorDir, "e2e/.qa-probe/probe.spec.ts", "x");
    const workspace = await adapterOf(f).create(f.request);
    assert.equal(readFileSync(join(workspace.dir, "src/app.ts"), "utf8"), "export const app = 1;\n");
    assert.equal(readFileSync(join(workspace.specDir, "fixtures.ts"), "utf8"), "export const test = 1;\n");
    assert.equal(readFileSync(join(workspace.specDir, "flows/existing.spec.ts"), "utf8"), "// existing\n");
    for (const left of ["node_modules", ".git", "e2e/.auth", ".env", ".env.production", "e2e/storageState.admin.json", "e2e/test-results", "e2e/.qa-probe"]) {
      assert.equal(existsSync(join(workspace.dir, left)), false, left);
    }
    assert.ok(workspace.dir.startsWith(f.root), "inside the delegations root");
    assert.ok(workspace.dir.includes("run-1") && workspace.dir.endsWith("run-1-flow-login"));
  }));

test("an example env file is source, not a secret, and is copied", () =>
  withFixture(async (f) => {
    put(f.mirrorDir, ".env.example", "API_URL=");
    const workspace = await adapterOf(f).create(f.request);
    assert.equal(existsSync(join(workspace.dir, ".env.example")), true);
  }));

test("a link in the working copy is not followed into the workspace, and a file past the size of a source is not copied", () =>
  withFixture(async (f) => {
    const outside = join(f.base, "outside.txt");
    writeFileSync(outside, "outside the mirror");
    symlinkSync(outside, join(f.mirrorDir, "src/link.ts"));
    put(f.mirrorDir, "src/huge.ts", Buffer.alloc(MAX_SPEC_SOURCE_BYTES + 1, 97));
    const workspace = await adapterOf(f).create(f.request);
    assert.equal(existsSync(join(workspace.dir, "src/link.ts")), false);
    assert.equal(existsSync(join(workspace.dir, "src/huge.ts")), false);
    assert.equal(existsSync(join(workspace.dir, "src/app.ts")), true);
  }));

test("the copy is cut at the number of files it is allowed, and says so", () =>
  withFixture(async (f) => {
    for (let i = 0; i < 20; i++) put(f.mirrorDir, `src/f${String(i).padStart(2, "0")}.ts`, `export const n = ${i};`);
    const workspace = await adapterOf(f, { maxFiles: 5 }).create(f.request);
    assert.equal(workspace.files, 5);
    assert.equal(workspace.cut, true);
  }));

test("the copy is cut at the bytes it is allowed", () =>
  withFixture(async (f) => {
    for (let i = 0; i < 10; i++) put(f.mirrorDir, `src/b${i}.ts`, Buffer.alloc(1_000, 97));
    const workspace = await adapterOf(f, { maxTotalBytes: 3_500 }).create(f.request);
    assert.equal(workspace.cut, true);
    assert.ok(readdirSync(join(workspace.dir, "src")).length < 10);
  }));

test("a delegation id that could leave the delegations root is refused before anything is made", () =>
  withFixture(async (f) => {
    for (const bad of ["../escape", "a/b", "", ".", "..", "x".repeat(200)]) {
      await assert.rejects(adapterOf(f).create({ ...f.request, delegationId: bad }), /delegation id/i, JSON.stringify(bad));
    }
    await assert.rejects(adapterOf(f).create({ ...f.request, runId: "../r" }), /run id/i);
    assert.equal(existsSync(f.root), false);
  }));

test("what the sidekick writes in its workspace never reaches the working copy until the orchestrator takes it", () =>
  withFixture(async (f) => {
    const workspace = await adapterOf(f).create(f.request);
    put(workspace.dir, "e2e/flows/login.spec.ts", "// written by the sidekick\n");
    put(workspace.dir, "src/app.ts", "export const app = 2;\n");
    assert.equal(existsSync(join(f.specDir, "flows/login.spec.ts")), false);
    assert.equal(readFileSync(join(f.mirrorDir, "src/app.ts"), "utf8"), "export const app = 1;\n");
  }));

test("taking the work back copies the writable file into the working copy and lists every other change as a proposal that is not applied", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    put(workspace.dir, "e2e/flows/login.spec.ts", "// login\n");
    put(workspace.dir, "e2e/flows/other.spec.ts", "// a sibling's file\n");
    put(workspace.dir, "src/app.ts", "export const app = 2;\n");
    rmSync(join(workspace.dir, "e2e/fixtures.ts"));
    const collected = await adapter.collect(workspace, f.request);
    assert.deepEqual(collected.copied, ["e2e/flows/login.spec.ts"]);
    assert.deepEqual(collected.refused, []);
    assert.equal(readFileSync(join(f.specDir, "flows/login.spec.ts"), "utf8"), "// login\n");
    assert.equal(existsSync(join(f.specDir, "flows/other.spec.ts")), false, "a file it was not given to write is not applied");
    assert.equal(readFileSync(join(f.mirrorDir, "src/app.ts"), "utf8"), "export const app = 1;\n");
    assert.equal(existsSync(join(f.specDir, "fixtures.ts")), true, "a deletion is not applied either");
    const byPath = new Map(collected.proposals.map((p) => [p.path, p.kind]));
    assert.equal(byPath.get("e2e/flows/other.spec.ts"), WORKSPACE_CHANGE.ADDED);
    assert.equal(byPath.get("src/app.ts"), WORKSPACE_CHANGE.MODIFIED);
    assert.equal(byPath.get("e2e/fixtures.ts"), WORKSPACE_CHANGE.DELETED);
    assert.equal(byPath.has("e2e/flows/login.spec.ts"), false, "the file that was copied back is not also a proposal");
    assert.equal(collected.proposalsTotal, 3);
  }));

test("a writable file the sidekick never made is neither copied nor refused", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    const collected = await adapter.collect(workspace, f.request);
    assert.deepEqual(collected.copied, []);
    assert.deepEqual(collected.refused, []);
    assert.equal(collected.proposalsTotal, 0);
  }));

test("a writable file that already existed and is byte-identical when the work is taken back is not reported as copied", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    const collected = await adapter.collect(workspace, f.request);
    assert.deepEqual(collected.copied, [], "the sidekick wrote nothing, so nothing went back");
    assert.deepEqual(collected.refused, []);
  }, { writablePaths: ["e2e/flows/existing.spec.ts"] }));

test("a writable file that already existed and was changed is copied back, and an untouched twin of it is not", () =>
  withFixture(async (f) => {
    put(f.mirrorDir, "e2e/flows/other.spec.ts", "// other\n");
    const request = { ...f.request, writablePaths: ["e2e/flows/existing.spec.ts", "e2e/flows/other.spec.ts"] };
    const adapter = adapterOf(f);
    const workspace = await adapter.create(request);
    put(workspace.dir, "e2e/flows/existing.spec.ts", "// improved\n");
    const collected = await adapter.collect(workspace, request);
    assert.deepEqual(collected.copied, ["e2e/flows/existing.spec.ts"]);
    assert.equal(readFileSync(join(f.mirrorDir, "e2e/flows/existing.spec.ts"), "utf8"), "// improved\n");
  }));

test("staging an existing writable file still copies it when it is unchanged, since the orchestrator runs it as it stands", () =>
  withFixture(async (f) => {
    const request = { ...f.request, writablePaths: ["e2e/flows/existing.spec.ts"] };
    const adapter = adapterOf(f);
    const workspace = await adapter.create(request);
    assert.equal(await adapter.stage(workspace, request, "e2e/flows/existing.spec.ts", ".qa-probe/existing.spec.ts"), true);
    assert.equal(readFileSync(join(f.specDir, ".qa-probe/existing.spec.ts"), "utf8"), "// existing\n");
  }));

test("a writable file that is a link is refused, and what it points at is never read", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    const secret = join(f.base, "secret.txt");
    writeFileSync(secret, "do not copy me");
    mkdirSync(join(workspace.dir, "e2e/flows"), { recursive: true });
    symlinkSync(secret, join(workspace.dir, "e2e/flows/login.spec.ts"));
    const collected = await adapter.collect(workspace, f.request);
    assert.deepEqual(collected.copied, []);
    assert.equal(collected.refused.length, 1);
    assert.equal(collected.refused[0]!.path, "e2e/flows/login.spec.ts");
    assert.equal(existsSync(join(f.specDir, "flows/login.spec.ts")), false);
  }));

test("a writable file past the size of a spec is refused", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    put(workspace.dir, "e2e/flows/login.spec.ts", Buffer.alloc(MAX_SPEC_SOURCE_BYTES + 1, 97));
    const collected = await adapter.collect(workspace, f.request);
    assert.equal(collected.refused.length, 1);
    assert.equal(existsSync(join(f.specDir, "flows/login.spec.ts")), false);
  }));

test("a directory of the sidekick's workspace that is a link cannot carry a writable file out", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    const elsewhere = join(f.base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "login.spec.ts"), "// planted");
    rmSync(join(workspace.dir, "e2e/flows"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(workspace.dir, "e2e/flows"));
    const collected = await adapter.collect(workspace, f.request);
    assert.deepEqual(collected.copied, []);
    assert.equal(existsSync(join(f.specDir, "flows/login.spec.ts")), false);
  }));

test("a writable path outside the spec directory is refused, however the brief came to name it", () =>
  withFixture(
    async (f) => {
      const adapter = adapterOf(f);
      const workspace = await adapter.create(f.request);
      put(workspace.dir, "src/injected.ts", "x");
      put(workspace.dir, "e2e/ok.spec.ts", "x");
      const collected = await adapter.collect(workspace, f.request);
      assert.deepEqual(collected.copied, []);
      assert.deepEqual(collected.refused.map((r) => r.path).sort(), ["../escape.spec.ts", "src/injected.ts"]);
      assert.equal(existsSync(join(f.mirrorDir, "src/injected.ts")), false);
      assert.equal(existsSync(join(f.base, "escape.spec.ts")), false);
    },
    { writablePaths: ["src/injected.ts", "../escape.spec.ts"] },
  ));

test("staging copies one writable file to a probe path in the working copy, says when there is none, and refuses a file that was not given to write and a place that is not a probe", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    const probe = ".qa-probe/login.spec.ts";
    assert.equal(await adapter.stage(workspace, f.request, "e2e/flows/login.spec.ts", probe), false, "nothing written yet");
    put(workspace.dir, "e2e/flows/login.spec.ts", "// v1\n");
    assert.equal(await adapter.stage(workspace, f.request, "e2e/flows/login.spec.ts", probe), true);
    assert.equal(readFileSync(join(f.specDir, probe), "utf8"), "// v1\n");
    assert.equal(existsSync(join(f.specDir, "flows/login.spec.ts")), false, "the file's own place in the suite is not touched");
    put(workspace.dir, "e2e/flows/login.spec.ts", "// v2\n");
    await adapter.stage(workspace, f.request, "e2e/flows/login.spec.ts", probe);
    assert.equal(readFileSync(join(f.specDir, probe), "utf8"), "// v2\n", "a later version replaces the earlier");
    put(workspace.dir, "e2e/flows/other.spec.ts", "x");
    await assert.rejects(adapter.stage(workspace, f.request, "e2e/flows/other.spec.ts", ".qa-probe/other.spec.ts"), /e2e\/flows\/other\.spec\.ts is not among/);
    for (const place of ["flows/login.spec.ts", "../escape.spec.ts", ".qa-probe/../flows/login.spec.ts"]) {
      await assert.rejects(adapter.stage(workspace, f.request, "e2e/flows/login.spec.ts", place), /probe directory/, place);
    }
    assert.equal(existsSync(join(f.specDir, "flows/other.spec.ts")), false);
    assert.equal(existsSync(join(f.specDir, "flows/login.spec.ts")), false);
  }));

test("disposing removes the workspace and the folder of its run once it is empty, and never throws", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    put(workspace.dir, "e2e/flows/login.spec.ts", "x");
    await adapter.dispose(workspace);
    assert.equal(existsSync(workspace.dir), false);
    assert.equal(existsSync(join(f.root, "run-1")), false);
    await adapter.dispose(workspace);
  }));

test("a run's folder stays while one of its other workspaces is still there", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const a = await adapter.create(f.request);
    const b = await adapter.create({ ...f.request, delegationId: "run-1-flow-cart" });
    await adapter.dispose(a);
    assert.equal(existsSync(b.dir), true);
    await adapter.dispose(b);
    assert.equal(existsSync(join(f.root, "run-1")), false);
  }));

test("sweeping removes every workspace there is, those of runs that never cleaned up included, and counts them", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    await adapter.create(f.request);
    await adapter.create({ ...f.request, delegationId: "run-1-flow-cart" });
    await adapter.create({ ...f.request, runId: "run-0", delegationId: "run-0-flow-x" });
    assert.equal(await adapter.sweepAll(), 3);
    assert.deepEqual(readdirSync(f.root), []);
    assert.equal(await adapter.sweepAll(), 0);
  }));

test("sweeping a root that was never made is nothing, and a root that is a link is not followed", () =>
  withFixture(async (f) => {
    assert.equal(await adapterOf(f).sweepAll(), 0);
    const victim = join(f.base, "victim");
    mkdirSync(join(victim, "run-x/deleg"), { recursive: true });
    writeFileSync(join(victim, "run-x/deleg/keep.txt"), "keep");
    symlinkSync(victim, f.root);
    assert.equal(lstatSync(f.root).isSymbolicLink(), true);
    assert.equal(await adapterOf(f).sweepAll(), 0);
    assert.equal(existsSync(join(victim, "run-x/deleg/keep.txt")), true, "what the link points at is left alone");
  }));

test("creating a workspace again for the same delegation starts from a clean one", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const first = await adapter.create(f.request);
    put(first.dir, "e2e/flows/stale.spec.ts", "left over");
    const second = await adapter.create(f.request);
    assert.equal(second.dir, first.dir);
    assert.equal(existsSync(join(second.dir, "e2e/flows/stale.spec.ts")), false);
  }));

test("refreshing brings the working copy's current writable files into the workspace, and only a change made after it goes back", () =>
  withFixture(async (f) => {
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    put(workspace.dir, "e2e/flows/login.spec.ts", "// the sidekick's first bytes\n");
    await adapter.collect(workspace, f.request);
    put(f.mirrorDir, "e2e/flows/login.spec.ts", "// corrected in the working copy since\n");
    assert.deepEqual(await adapter.refresh(workspace, f.request), ["e2e/flows/login.spec.ts"]);
    assert.equal(readFileSync(join(workspace.dir, "e2e/flows/login.spec.ts"), "utf8"), "// corrected in the working copy since\n");
    assert.deepEqual((await adapter.collect(workspace, f.request)).copied, [], "unchanged since the refresh: nothing goes back");
    put(workspace.dir, "e2e/flows/login.spec.ts", "// the sidekick's correction\n");
    assert.deepEqual((await adapter.collect(workspace, f.request)).copied, ["e2e/flows/login.spec.ts"]);
    assert.equal(readFileSync(join(f.mirrorDir, "e2e/flows/login.spec.ts"), "utf8"), "// the sidekick's correction\n");
  }));

test("refreshing reads the working copy strictly: a writable file that is a link there is not followed, and none outside the spec directory is reached", () =>
  withFixture(async (f) => {
    put(f.base, "secret.txt", "secret\n");
    symlinkSync(join(f.base, "secret.txt"), join(f.specDir, "flows/login.spec.ts"));
    const adapter = adapterOf(f);
    const workspace = await adapter.create(f.request);
    assert.deepEqual(await adapter.refresh(workspace, f.request), []);
    assert.equal(existsSync(join(workspace.dir, "e2e/flows/login.spec.ts")) && readFileSync(join(workspace.dir, "e2e/flows/login.spec.ts"), "utf8").includes("secret"), false);
    const outside = { ...f.request, writablePaths: ["src/app.ts"] };
    assert.deepEqual(await adapter.refresh(await adapter.create(outside), outside), []);
  }));
