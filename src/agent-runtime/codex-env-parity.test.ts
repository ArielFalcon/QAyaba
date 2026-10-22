import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_EXEC_ENV_EXACT as orchestratorExact, CODEX_EXEC_ENV_PREFIX as orchestratorPrefix } from "./codex-strategy";
// @ts-expect-error the supervisor is plain JavaScript with no declaration file
import { CODEX_EXEC_ENV_EXACT as supervisorExact, CODEX_EXEC_ENV_PREFIX as supervisorPrefix } from "../../agents/agent-supervisor.mjs";

test("the supervisor forwards to `codex exec` exactly the environment names the orchestrator's builder forwards", () => {
  assert.deepEqual([...(supervisorExact as Set<string>)].sort(), [...orchestratorExact].sort());
  assert.equal((supervisorPrefix as RegExp).source, orchestratorPrefix.source);
});

test("the trace context names are among the exact names, since the prefix list does not match them", () => {
  for (const name of ["TRACEPARENT", "TRACESTATE"]) {
    assert.ok(orchestratorExact.has(name), name);
    assert.ok((supervisorExact as Set<string>).has(name), name);
    assert.equal(orchestratorPrefix.test(name), false, name);
  }
});
