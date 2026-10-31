/* The mirror refresh runs one hardened, environment-scrubbed `git fetch` in the mirror and never fails the caller on its outcome. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { GitMirrorRefreshAdapter } from "../../../../../src/contexts/service-topology/infrastructure/adapters/git-mirror-refresh.adapter.ts";
import { hardenGitArgs } from "../../../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";
import type { SandboxedRunRequest, SandboxedRunResult } from "../../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

test("the fetch is hardened against the mirror it refreshes and runs with a scrubbed environment", async () => {
  const seen: SandboxedRunRequest[] = [];
  const runner = { run: async (req: SandboxedRunRequest): Promise<SandboxedRunResult> => { seen.push(req); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; } };
  process.env["QA_TEST_SECRET_TOKEN"] = "must-not-reach-the-child";
  try {
    await new GitMirrorRefreshAdapter(runner).refresh("/mirrors/svc");
  } finally {
    delete process.env["QA_TEST_SECRET_TOKEN"];
  }
  assert.equal(seen.length, 1);
  const [req] = seen;
  assert.equal(req?.command, "git");
  assert.deepEqual(req?.args, hardenGitArgs(["fetch", "--no-recurse-submodules", "origin"], "/mirrors/svc"));
  assert.equal(req?.cwd, "/mirrors/svc");
  assert.equal(req?.env["QA_TEST_SECRET_TOKEN"], undefined);
  assert.ok((req?.timeoutMs ?? 0) > 0);
});

test("a fetch that fails or times out leaves the refresh resolved, with the mirror as it is", async () => {
  const runner = { run: async (): Promise<SandboxedRunResult> => ({ exitCode: null, stdout: "", stderr: "boom", timedOut: true }) };
  await assert.doesNotReject(new GitMirrorRefreshAdapter(runner).refresh("/mirrors/svc"));
});
