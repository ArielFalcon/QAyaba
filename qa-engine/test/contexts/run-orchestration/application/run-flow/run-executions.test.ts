/* The run's executions as its record keeps them: each with the conditions its runner reported, in the order they ran, and the DEV writes the run had counted when it started. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExecutions } from "@contexts/run-orchestration/application/run-flow/run-executions.ts";
import { executionConditions } from "@kernel/execution-conditions.ts";
import { purposeOfExecution } from "@kernel/exec-purpose.ts";
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

/* A runner that reports the session it was handed, as the e2e runner does, and ends its one test on the app's login page. */
const onLoginPage = (calls: { n: number }, startedAt: number): ExecutionPort => ({
  execute: async (_dir, opts) => {
    calls.n += 1;
    const o = opts instanceof AbortSignal || opts === undefined ? {} : opts;
    return {
      verdict: "fail",
      cases: [{ name: "a.spec.ts › opens the orders", file: "a.spec.ts", status: "fail", finalUrl: "https://dev.example/login?next=%2Forders", failureDom: 'heading: Sign in\ntextbox: "Password"' }],
      logs: "",
      conditions: executionConditions({ purpose: purposeOfExecution(o), instrumentation: NONE, processTimeoutMs: 1_000, namespace: o.namespace ?? "run-1", startedAt, ...(o.session ? { session: o.session } : {}) }),
    };
  },
});

test("after the run signs a saved session in, every execution is told when and the record keeps the session's age at its start, a mutant's re-run included", async () => {
  const signedInAt = 1_000_000;
  const executions = runExecutions();
  executions.signedIn(signedInAt);
  const execution = executions.port(onLoginPage({ n: 0 }, signedInAt + 90_000));

  await execution.execute("/e2e", { namespace: "run-1" });
  await execution.execute("/e2e", { namespace: "run-1-mut0", mutant: '{"url":"https://dev.example/main.js"}', specFiles: ["a.spec.ts"] });

  assert.deepEqual(executions.signal()?.runs.map((r) => [r.purpose, r.sessionAgeMs]), [["suite", 90_000], ["mutant", 90_000]]);
});

test("the session's age is a record, never acted on: a failure on the app's login page runs once and stands as it ran", async () => {
  const calls = { n: 0 };
  const executions = runExecutions();
  executions.signedIn(Date.now());

  const result = await executions.port(onLoginPage(calls, Date.now())).execute("/e2e", { namespace: "run-1" });

  assert.equal(calls.n, 1);
  assert.equal(result.verdict, "fail");
  assert.equal(executions.signal()?.sessionChecks, undefined);
});
