import { test } from "node:test";
import assert from "node:assert/strict";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { ExecutionRequest } from "@contexts/test-execution/application/ports/index.ts";

/* ExecutionRequest carries the full set of ExecuteOptions / CodeExecuteOptions fields so no
   capability is silently dropped at the port boundary:
   e2e: project? (PW --project), onCase?, onRunning?, onDiscovered? (live progress callbacks)
   code: changedFiles? (diff-driven module scoping)
 */
const req: ExecutionRequest = { specDir: "/m/e2e", baseUrl: "https://dev", namespace: "qa-abc" };

test("delegates to runE2E with the mapped opts and returns the verdict/cases/logs", async () => {
  let seen: { dir: string; baseUrl: string; namespace: string } | null = null;
  const strategy = new E2eExecutionStrategy(async (dir, opts) => {
    seen = { dir, baseUrl: opts.baseUrl, namespace: opts.namespace };
    return { sha: "abc", verdict: "pass", passed: true, cases: [{ name: "t", status: "pass" }], logs: "ok" };
  });
  const out = await strategy.run(req);
  assert.deepEqual(seen, { dir: "/m/e2e", baseUrl: "https://dev", namespace: "qa-abc" });
  assert.equal(out.verdict, "pass");
  assert.equal(out.cases.length, 1);
  assert.equal(out.logs, "ok");
});

/*
 * O11: runner-infra reclassification has a SINGLE owner now — e2e-execution.runner.ts's own
 * allFailuresAreRunnerInfra, which runs inside the real runE2E before this strategy ever sees a
 * verdict (both of runE2E's production callers — this strategy AND the fault-injection oracle's
 * runCorruptedFaultInjection re-run — depend on that SAME upstream reclassification; the strategy
 * previously duplicated the exact same check via AdjudicateService/AppDefect, which never actually
 * fired against the real runE2E and computed an AppDefect value nothing ever read). The strategy
 * now passes the injected runE2E's verdict straight through, unchanged, whatever it is — a fake
 * runE2E that skips its own reclassification (unlike the real one) gets no second chance here.
 */
test("passes the injected runE2E's verdict straight through — no second reclassification pass at the strategy boundary", async () => {
  const strategy = new E2eExecutionStrategy(async () => ({
    sha: "abc", verdict: "fail", passed: false,
    cases: [{ name: "t", status: "fail", detail: "browserType.launch: Executable doesn't exist" }],
    logs: "boom",
  }));
  const out = await strategy.run(req);
  assert.equal(out.verdict, "fail", "reclassification is runE2E's own job now (single owner) — the strategy must not re-derive it");
});

test("throws when baseUrl is absent (e2e requires a live DEV URL)", async () => {
  const strategy = new E2eExecutionStrategy(async () => ({ sha: "abc", verdict: "pass", passed: true, cases: [], logs: "" }));
  await assert.rejects(() => strategy.run({ specDir: "/m/e2e", namespace: "qa-abc" }), /baseUrl/);
});

/* Pin optional-field threading — a silently-dropped onCase/onRunning/onDiscovered/project/faultInject
   breaks the live bar and history callbacks with no other failing test.
 */
test("threads all optional ExecutionRequest fields (project, onCase, onRunning, onDiscovered, faultInject) to the injected runE2E fn", async () => {
  type Opts = { baseUrl: string; namespace: string; project?: string; onCase?: unknown; onRunning?: unknown; onDiscovered?: unknown; faultInject?: boolean };
  let capturedOpts: Opts | null = null;
  const strategy = new E2eExecutionStrategy(async (_dir, opts) => {
    capturedOpts = opts as Opts;
    return { sha: "abc", verdict: "pass", passed: true, cases: [], logs: "" };
  });
  const onCase = (c: { name: string; status: string }) => { void c; };
  const onRunning = (title: string) => { void title; };
  const onDiscovered = (title: string, file?: string) => { void title; void file; };
  await strategy.run({
    specDir: "/m/e2e",
    baseUrl: "https://dev",
    namespace: "qa-abc",
    project: "chromium",
    onCase,
    onRunning,
    onDiscovered,
    faultInject: true,
  });
  assert.ok(capturedOpts !== null, "runE2E fn must be called");
  assert.equal((capturedOpts as Opts).project, "chromium", "project must be threaded");
  assert.equal((capturedOpts as Opts).onCase, onCase, "onCase callback must be threaded");
  assert.equal((capturedOpts as Opts).onRunning, onRunning, "onRunning callback must be threaded");
  assert.equal((capturedOpts as Opts).onDiscovered, onDiscovered, "onDiscovered callback must be threaded");
  assert.equal((capturedOpts as Opts).faultInject, true, "faultInject must be threaded");
});

/* A3: testIdAttribute must reach the runner opts — apps declare their test-id convention in config
   (e.g. data-cy for jhipster) and the DOM capture / selector catalog / authoring contract all
   validate against it, but the VERDICTUAL Playwright run never received it, so PW_TEST_ID_ATTRIBUTE
   was never set and getByTestId silently resolved the default data-testid on non-default apps.
 */
test("testIdAttribute reaches the runner opts", async () => {
  let seen: Record<string, unknown> = {};
  const strategy = new E2eExecutionStrategy(async (_dir, opts) => { seen = opts as Record<string, unknown>; return { verdict: "pass", cases: [], logs: "" }; });
  await strategy.run({ specDir: "/tmp/x", baseUrl: "http://dev", namespace: "ns", testIdAttribute: "data-cy" });
  assert.equal(seen.testIdAttribute, "data-cy");
});

/* The strategy must not keep only {name, status, detail?}, silently dropping
   failureDom/httpStatus/finalUrl/runtimeErrors/file/durationMs/flow/objective/reason before they
   reach the FixLoop aggregate (adjudicator Rules 2.5/2.6, Lever-2). The full evidence set survives
   the strategy boundary unchanged.
 */
test("evidence fields survive the strategy boundary (G1 kernel widening)", async () => {
  const evidenceCase = {
    name: "checkout shows total", status: "fail" as const, detail: "expect(received).toBe",
    flow: "checkout", objective: "verify totals", reason: "assertion",
    durationMs: 812, failureDom: '- button "Pay"', file: "e2e/checkout.spec.ts",
    httpStatus: 500, finalUrl: "https://dev.example.com/cart",
    runtimeErrors: [{ type: "pageerror", text: "NG0303: unregistered icon" }],
  };
  const strategy = new E2eExecutionStrategy(async () => ({ verdict: "fail", cases: [evidenceCase], logs: "" }));
  const res = await strategy.run({ specDir: "/tmp/x", baseUrl: "http://dev", namespace: "ns" });
  assert.deepEqual(res.cases[0], evidenceCase);
});
