/* The run's executions as its record keeps them: each with the conditions its runner reported, in the order they ran, and the DEV writes the run had counted when it started. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExecutions } from "@contexts/run-orchestration/application/run-flow/run-executions.ts";
import { executionConditions } from "@kernel/execution-conditions.ts";
import type { ExecutionPort } from "@contexts/test-execution/application/index.ts";

const NONE = { coverage: false, observe: false, route: false, writeCounter: false };

const port = (): ExecutionPort => ({
  execute: async (_dir, opts) => {
    const o = opts instanceof AbortSignal || opts === undefined ? {} : opts;
    return {
      verdict: "pass",
      cases: [],
      logs: "",
      conditions: executionConditions({ purpose: o.purpose ?? "suite", instrumentation: NONE, processTimeoutMs: 1_000, namespace: o.namespace ?? "run-1", startedAt: 0, ...(o.specFiles ? { specFiles: o.specFiles } : {}) }),
    };
  },
});

test("every execution is recorded with the DEV writes the run had counted when it started", async () => {
  let writes = 0;
  const executions = runExecutions({ devWrites: () => writes });
  const execution = executions.port(port());

  await execution.execute("/e2e", { namespace: "run-1" });
  writes = 3;
  await execution.execute("/e2e", { namespace: "run-1-measure", purpose: "measurement", specFiles: ["flows/a.spec.ts"] });

  const runs = executions.signal()?.runs ?? [];
  assert.deepEqual(runs.map((r) => [r.namespace, r.devWritesBefore, r.specFiles]), [
    ["run-1", 0, "suite"],
    ["run-1-measure", 3, ["flows/a.spec.ts"]],
  ]);
});

test("a run that counts no DEV writes records none", async () => {
  const executions = runExecutions();
  await executions.port(port()).execute("/e2e", { namespace: "run-1" });

  assert.equal(executions.signal()?.runs[0]?.devWritesBefore, undefined);
});
