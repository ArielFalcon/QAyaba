/* The views of the active exec scope that the run flow reads through ExecScopePort. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ambientExecScope } from "../../../src/shared-infrastructure/process-sandbox/ambient-exec-scope.ts";
import { SandboxUnavailableError } from "../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";

test("outside a run there is no scope, no refusal and no sandbox signal", () => {
  assert.equal(ambientExecScope.activeExecScope(), undefined);
  assert.equal(ambientExecScope.sandboxRefused(), false);
  assert.equal(ambientExecScope.sandboxSignal(), undefined);
});

test("a refused scope reports the refusal to code running inside it, and spawns nothing", () => {
  const scope = ambientExecScope.refusedScope("run-1", "uid");
  assert.equal(scope.workDir, "");
  const seen = ambientExecScope.withExecScope(scope, () => ({
    active: ambientExecScope.activeExecScope(),
    refused: ambientExecScope.sandboxRefused(),
    signal: ambientExecScope.sandboxSignal(),
  }));
  assert.equal(seen.active, scope);
  assert.equal(seen.refused, true);
  assert.equal(seen.signal, undefined);
});

test("a sandbox that saw a denied host exposes it as the run's signal", () => {
  const scope = ambientExecScope.refusedScope("run-2", "egress");
  scope.report.denied.push("blocked.example");
  const signal = ambientExecScope.withExecScope(scope, () => ambientExecScope.sandboxSignal());
  assert.deepEqual(signal, { egress: "not-applicable", denied: ["blocked.example"] });
});

test("only the sandbox-unavailable error is recognised as a refusal to open the scope", () => {
  assert.equal(ambientExecScope.isSandboxUnavailable(new SandboxUnavailableError("residue", "x")), true);
  assert.equal(ambientExecScope.isSandboxUnavailable(new Error("x")), false);
});
