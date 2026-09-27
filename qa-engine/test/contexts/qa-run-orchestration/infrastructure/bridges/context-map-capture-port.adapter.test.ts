import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextMapCapturePortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/context-map-capture-port.adapter.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";

const VALID_CONTEXT_JSON: ArchitectureContext = {
  builtAtSha: "abc1234",
  routes: [{ path: "/owners" }],
  api: [{ operationId: "getOwners", method: "GET", path: "/api/owners" }],
  feBe: [{ route: "/owners", operationId: "getOwners" }],
};

test("capture(): a valid committed context.json is saved via the injected saveFn, keyed by the deterministic run sha", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ctxcapture-valid-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), JSON.stringify(VALID_CONTEXT_JSON));
    const saved: Array<{ app: string; sha: string; data: ArchitectureContext }> = [];
    const adapter = new ContextMapCapturePortAdapter((app, sha, data) => { saved.push({ app, sha, data }); });

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
    const adapter = new ContextMapCapturePortAdapter(() => { saveCallCount++; });

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
    const adapter = new ContextMapCapturePortAdapter(() => { saveCallCount++; });

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
      (err) => { logged = err; },
    );

    await assert.doesNotReject(adapter.capture(dir, "demo", "deadbeef1"));

    assert.ok(logged instanceof Error);
    assert.equal((logged as Error).message, "db down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
