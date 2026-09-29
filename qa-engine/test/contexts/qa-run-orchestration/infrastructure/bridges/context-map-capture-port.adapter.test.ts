import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UntrustedGitTreeError } from "@kernel/domain-error.ts";
import { ContextMapCapturePortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/context-map-capture-port.adapter.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";

const VALID_CONTEXT_JSON: ArchitectureContext = {
  builtAtSha: "abc1234",
  routes: [{ path: "/owners" }],
  api: [{ operationId: "getOwners", method: "GET", path: "/api/owners" }],
  feBe: [{ route: "/owners", operationId: "getOwners" }],
};

/* Whether the run wrote the map is decided at the process boundary (the mirror's git status). */
const WRITTEN_THIS_RUN = (): boolean => true;

test("capture(): a valid context.json the run wrote is saved via the injected saveFn, keyed by the deterministic run sha", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ctxcapture-valid-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), JSON.stringify(VALID_CONTEXT_JSON));
    const saved: Array<{ app: string; sha: string; data: ArchitectureContext }> = [];
    const adapter = new ContextMapCapturePortAdapter((app, sha, data) => { saved.push({ app, sha, data }); }, WRITTEN_THIS_RUN);

    await adapter.capture(dir, "demo", "deadbeef1");

    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.app, "demo");
    assert.equal(saved[0]!.sha, "deadbeef1", "the deterministic run sha is what gets stored, not the agent's own self-reported builtAtSha field");
    assert.deepEqual(saved[0]!.data, VALID_CONTEXT_JSON, "the validated map is stored unmodified — data.builtAtSha stays the agent's own value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): a missing context.json is a no-op — saveFn is never called, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ctxcapture-missing-"));
  try {
    let saveCallCount = 0;
    const adapter = new ContextMapCapturePortAdapter(() => { saveCallCount++; }, WRITTEN_THIS_RUN);

    await adapter.capture(dir, "demo", "deadbeef1");

    assert.equal(saveCallCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): a malformed/invalid context.json degrades to a no-op — never throws, never saves a partial/invalid map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ctxcapture-invalid-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), "{ not valid json");
    let saveCallCount = 0;
    const adapter = new ContextMapCapturePortAdapter(() => { saveCallCount++; }, WRITTEN_THIS_RUN);

    await adapter.capture(dir, "demo", "deadbeef1");

    assert.equal(saveCallCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): a throwing saveFn is fault-isolated — never escapes, is reported through the onError hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ctxcapture-savefail-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), JSON.stringify(VALID_CONTEXT_JSON));
    let logged: unknown;
    const adapter = new ContextMapCapturePortAdapter(
      () => { throw new Error("db down"); },
      WRITTEN_THIS_RUN,
      (err) => { logged = err; },
    );

    await assert.doesNotReject(adapter.capture(dir, "demo", "deadbeef1"));

    assert.ok(logged instanceof Error);
    assert.equal((logged as Error).message, "db down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): a valid map the run did not write is never saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ctxcapture-untouched-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), JSON.stringify(VALID_CONTEXT_JSON));
    const asked: string[] = [];
    let saveCallCount = 0;
    const adapter = new ContextMapCapturePortAdapter(() => { saveCallCount++; }, (specDir) => { asked.push(specDir); return false; });

    await adapter.capture(dir, "demo", "deadbeef1");

    assert.deepEqual(asked, [dir], "the spec dir is what is checked");
    assert.equal(saveCallCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): a map whose origin cannot be told is not saved, and the failure is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ctxcapture-unknown-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), JSON.stringify(VALID_CONTEXT_JSON));
    let logged: unknown;
    let saveCallCount = 0;
    const adapter = new ContextMapCapturePortAdapter(
      () => { saveCallCount++; },
      () => { throw new Error("not a git repository"); },
      (err) => { logged = err; },
    );

    await assert.doesNotReject(adapter.capture(dir, "demo", "deadbeef1"));

    assert.equal(saveCallCount, 0);
    assert.match(String(logged), /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): an untrusted git dir found while asking whether the run wrote the map is not swallowed as an off-path failure", async () => {
  const swallowed: unknown[] = [];
  const adapter = new ContextMapCapturePortAdapter(
    () => {},
    () => { throw new UntrustedGitTreeError("refusing to run git on /mirrors/org__app/.git: it is a symbolic link"); },
    (err) => void swallowed.push(err),
  );

  await assert.rejects(adapter.capture("/mirrors/org__app/e2e", "demo", "deadbeef1"), UntrustedGitTreeError);
  assert.deepEqual(swallowed, []);
});

test("capture(): any other failure to tell whether the run wrote the map stays an off-path failure", async () => {
  const swallowed: unknown[] = [];
  const adapter = new ContextMapCapturePortAdapter(
    () => {},
    () => { throw new Error("git status failed"); },
    (err) => void swallowed.push(err),
  );

  await adapter.capture("/mirrors/org__app/e2e", "demo", "deadbeef1");

  assert.equal(swallowed.length, 1);
});
