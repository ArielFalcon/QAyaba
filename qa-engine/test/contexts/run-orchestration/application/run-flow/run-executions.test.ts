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

/* A test the app sent to its login page: what makes the port ask whether the session is gone. */
const ON_LOGIN = { name: "a.spec.ts › opens the orders", file: "a.spec.ts", status: "fail" as const, detail: "locator.click: Timeout 8000ms exceeded", finalUrl: "https://dev.example/login?next=%2Forders", failureDom: 'heading: Sign in\ntextbox: "Password"' };

/* An execution that always ends on the login page, and a guard whose check always finds the session gone. */
function lostEveryTime(renewal: "signs-in" | "fails" = "signs-in"): { execution: ExecutionPort; runs: () => number; renewals: () => number } {
  let runs = 0;
  let renewals = 0;
  const executions = runExecutions();
  executions.signedIn(Date.now());
  const base: ExecutionPort = { execute: async () => (runs++, { verdict: "fail", cases: [ON_LOGIN], logs: "" }) };
  const execution = executions.port(base, {
    check: async () => ({ state: "lost", detail: "the page ended on the login path /login" }),
    renew: async () => (renewals++, renewal === "signs-in" ? { renewed: true } : { failed: "the login form never appeared", preconditionFailed: true }),
  });
  return { execution, runs: () => runs, renewals: () => renewals };
}

const MUTANT = JSON.stringify({ url: "https://dev.example/main.js", sha256: "abc", start: 1, end: 2, replacement: "!a" });

test("a mutant's re-run whose renewed session is shown gone again is not judged (session-lost) and ends nothing", async () => {
  const { execution, runs, renewals } = lostEveryTime();

  const result = await execution.execute("/e2e", { namespace: "run-1-mut0", mutant: MUTANT, specFiles: ["a.spec.ts"] });

  assert.equal(result.notJudged, "session-lost");
  assert.equal(runs(), 2, "renewed and re-run once, as a verdict execution is");
  assert.equal(renewals(), 1);
});

test("a mutant's re-run whose session could not be renewed is not judged (session-lost) and ends nothing", async () => {
  const { execution, runs } = lostEveryTime("fails");

  const result = await execution.execute("/e2e", { namespace: "run-1-mut0", mutant: MUTANT, specFiles: ["a.spec.ts"] });

  assert.equal(result.notJudged, "session-lost");
  assert.equal(runs(), 1, "nothing runs on a session that could not be renewed");
});

test("an execution that judges the verdict and meets a lost session twice ends the run, as one that cannot renew it does", async () => {
  await assert.rejects(lostEveryTime().execution.execute("/e2e", { namespace: "run-1" }), { name: "SessionLostError" });
  await assert.rejects(lostEveryTime().execution.execute("/e2e", { namespace: "run-1-acc", purpose: "acceptance" }), { name: "SessionLostError" });
  await assert.rejects(lostEveryTime("fails").execution.execute("/e2e", { namespace: "run-1-fix1", purpose: "fix-retry" }), { name: "LoginRenewalError" });
});
