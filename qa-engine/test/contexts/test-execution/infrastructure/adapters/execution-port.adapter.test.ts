/* test/contexts/run-orchestration/infrastructure/adapters/execution-port.adapter.test.ts
   (E2eExecutionStrategy), implementing ExecutionStrategyPort.run(req).
   THIN — no new policy: this adapter only maps ExecutionPort.execute(specDir) onto the richer
   ExecutionRequest shape (baseUrl/namespace held as static per-run context) and runs the
   strategy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionPortAdapter } from "@contexts/test-execution/infrastructure/adapters/execution-port.adapter.ts";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { E2eExecuteOptions } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";

/* Exhaustiveness guard: E2eExecuteOptions no longer straddles the src/qa-engine boundary — both
   sides of this guard are qa-engine-internal. A field ADDED to E2eExecuteOptions without a matching
   mapped/allowlisted entry FAILS TYPECHECK (`satisfies`); a field silently DROPPED by
   ExecutionPortAdapter FAILS THIS TEST.
 */
const E2E_EXECUTE_OPTIONS_ALL_FIELDS = {
  baseUrl: true, namespace: true, onCase: true, onRunning: true, onDiscovered: true,
  signal: true, timeoutMs: true, project: true, testIdAttribute: true,
  specFiles: true, retries: true, grep: true, countWrites: true, cleanupPass: true, mutant: true, observe: true,
} satisfies Record<keyof E2eExecuteOptions, true>;

const E2E_EXECUTE_OPTIONS_ALLOWLIST: Record<string, string> = {
  baseUrl: "held as ExecutionPortStaticContext (constructor-time, not per-call) — carried through ctx.baseUrl, asserted by the dispatch tests below, not a drop.",
  namespace: "held as ExecutionPortStaticContext (constructor-time, overridable per-call via opts.namespace) — asserted by the dispatch/override tests below, not a drop.",
  cleanupPass: "a dedicated cleanup pass is a separate call to runE2E (scripts/campaign.ts); a pipeline run's execution is never one, so the port has nothing to map.",
  mutant: "the mutation pass is a separate call to runE2E by the bundle mutation; a pipeline run's execution never carries a mutant, so the port has nothing to map.",
  observe: "the observation of pages is the mutation oracle's own call to runE2E (a mutant's re-run and the unmutated re-run it is compared with); a pipeline run's execution never observes, so the port has nothing to map.",
};

test("E2eExecuteOptions' own field list matches the allowlist + ExecutionPortAdapter's mapped set exactly (retired seam-parity block (c))", () => {
  const mapped = ["onCase", "onRunning", "onDiscovered", "signal", "timeoutMs", "project", "testIdAttribute", "specFiles", "retries", "grep", "countWrites"];
  const allFieldNames = Object.keys(E2E_EXECUTE_OPTIONS_ALL_FIELDS).sort();
  const accountedFor = [...new Set([...mapped, ...Object.keys(E2E_EXECUTE_OPTIONS_ALLOWLIST)])].sort();
  assert.deepEqual(accountedFor, allFieldNames, "every E2eExecuteOptions field must be either mapped by ExecutionPortAdapter or allowlisted with a reason");
});

test("execute() dispatches to E2eExecutionStrategy and forwards baseUrl/namespace", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [{ name: "checkout", status: "pass" }], logs: `ran ${specDir}` };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const result = await adapter.execute("/mirrors/org/app/e2e");

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.cases, [{ name: "checkout", status: "pass" }]);
  assert.match(result.logs, /\/mirrors\/org\/app\/e2e/);
  assert.equal((capturedOpts as { baseUrl: string }).baseUrl, "https://dev.example.com");
  assert.equal((capturedOpts as { namespace: string }).namespace, "qa-bot-abc1234");
});

/* The queue's AbortSignal must reach Playwright: the adapter declares and forwards it. */

test("execute() forwards an AbortSignal into the e2e strategy's ExecutionRequest", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedSignal = opts.signal;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", controller.signal);

  assert.equal(capturedSignal, controller.signal, "the SAME AbortSignal instance passed to execute() must reach the e2e strategy's ExecutionRequest.signal, not be dropped at the adapter");
});

/* testIdAttribute must reach the e2e strategy so PW_TEST_ID_ATTRIBUTE is set for the verdictual
   Playwright run — otherwise getByTestId silently resolves the default data-testid on non-default apps.
 */
test("execute() forwards testIdAttribute from static context into the e2e strategy's ExecutionRequest", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter(
    { e2e },
    { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234", testIdAttribute: "data-cy" },
  );

  await adapter.execute("/mirrors/org/app/e2e");

  assert.equal((capturedOpts as { testIdAttribute?: string }).testIdAttribute, "data-cy");
});

test("execute() with no signal at all behaves exactly as before (no second-arg regression)", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const result = await adapter.execute("/mirrors/org/app/e2e");

  assert.equal(result.verdict, "pass");
  assert.equal((capturedOpts as { signal?: AbortSignal }).signal, undefined, "an absent signal must remain absent downstream — no fabricated AbortSignal");
});

/* ExecutionPort.execute accepts an ExecutionOpts bag (specFiles/project/
   timeoutMs/onCase/onRunning/onDiscovered), not only a bare AbortSignal as the 2nd arg.
 */

test("execute() still accepts a bare AbortSignal as the 2nd arg (old 2-arg callers keep compiling and working)", async () => {
  const controller = new AbortController();
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const result = await adapter.execute("/mirrors/org/app/e2e", controller.signal);

  assert.equal(result.verdict, "pass");
  assert.equal((capturedOpts as { signal?: AbortSignal }).signal, controller.signal, "a bare AbortSignal 2nd arg must still reach ExecutionRequest.signal");
});

test("execute() forwards specFiles from the opts bag into the e2e strategy's ExecutionRequest (filtered-retry)", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", { specFiles: ["login.spec.ts", "checkout.spec.ts"] });

  assert.deepEqual((capturedOpts as { specFiles?: string[] }).specFiles, ["login.spec.ts", "checkout.spec.ts"]);
});

test("execute() forwards project/timeoutMs from the opts bag into the e2e strategy", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", { project: "chromium", timeoutMs: 45000 });

  const opts = capturedOpts as { project?: string; timeoutMs?: number };
  assert.equal(opts.project, "chromium");
  assert.equal(opts.timeoutMs, 45000);
});

test("execute() forwards onCase/onRunning/onDiscovered live-progress callbacks into the e2e strategy", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const seenCases: unknown[] = [];
  const seenRunning: string[] = [];
  const seenDiscovered: [string, string | undefined][] = [];
  await adapter.execute("/mirrors/org/app/e2e", {
    onCase: (c) => seenCases.push(c),
    onRunning: (title) => seenRunning.push(title),
    onDiscovered: (title, file) => seenDiscovered.push([title, file]),
  });

  const opts = capturedOpts as {
    onCase?: (c: { name: string; status: string; detail?: string }) => void;
    onRunning?: (title: string) => void;
    onDiscovered?: (title: string, file?: string) => void;
  };
  opts.onCase?.({ name: "checkout", status: "pass" });
  opts.onRunning?.("login");
  opts.onDiscovered?.("checkout", "checkout.spec.ts");

  assert.deepEqual(seenCases, [{ name: "checkout", status: "pass" }]);
  assert.deepEqual(seenRunning, ["login"]);
  assert.deepEqual(seenDiscovered, [["checkout", "checkout.spec.ts"]]);
});

/* The enforce-mode coverage regen re-executes under a DEDICATED namespace
   (`${runId}-coverage-regen`) so its coverage dumps never collide with / get shadowed by the first
   run's dumps. Without an override every call falls back to ctx.namespace (the static per-run
   value), which is what the regen must escape from.
 */

test("execute() forwards opts.namespace to the e2e strategy, overriding ctx.namespace", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", { namespace: "qa-bot-abc1234-coverage-regen" });

  assert.equal((capturedOpts as { namespace: string }).namespace, "qa-bot-abc1234-coverage-regen", "opts.namespace must override ctx.namespace for the e2e strategy");
});

test("execute() falls back to ctx.namespace when opts.namespace is absent (backward compatible)", async () => {
  let e2eOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => { e2eOpts = opts; return { verdict: "pass", cases: [], logs: "" }; });

  const e2eAdapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });
  await e2eAdapter.execute("/mirrors/org/app/e2e");
  assert.equal((e2eOpts as { namespace: string }).namespace, "qa-bot-abc1234");
});

test("execute() forwards a single-attempt, title-filtered run to the strategy and hands back the writes it counted", async () => {
  let seen: { retries?: number; grep?: string; specFiles?: string[]; countWrites?: boolean } = {};
  const e2e = new E2eExecutionStrategy(async (_dir, opts) => {
    seen = { retries: opts.retries, grep: opts.grep, specFiles: opts.specFiles, countWrites: opts.countWrites };
    return { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 2 };
  });
  const adapter = new ExecutionPortAdapter({ e2e }, { baseUrl: "https://dev", namespace: "ns" });
  const result = await adapter.execute("/m/e2e", { specFiles: ["a.spec.ts"], retries: 0, grep: "loads", countWrites: true });
  assert.deepEqual(seen, { retries: 0, grep: "loads", specFiles: ["a.spec.ts"], countWrites: true });
  assert.equal(result.devWrites, 2);
});

