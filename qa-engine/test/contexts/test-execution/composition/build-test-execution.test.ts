/* buildTestExecution: the returned API serves the validation and execution ports, and each dispatches to the strategy of the run's target. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestExecution, type TestExecutionDeps } from "@contexts/test-execution/composition/build-test-execution.ts";

function deps(target: "e2e" | "code", seen: string[]): TestExecutionDeps {
  return {
    target,
    namespace: "ns",
    validationStrategies: {
      e2e: { validateAll: async () => { seen.push("e2e-validate"); return { ok: true, errors: [], infra: false }; }, autofix: async () => { seen.push("e2e-autofix"); return ["a.spec.ts"]; } },
      code: { validate: async () => { seen.push("code-validate"); return { ok: false, errors: ["boom"], infra: false }; } },
    },
    executionStrategies: {
      e2e: { run: async () => { seen.push("e2e-run"); return { status: "pass" } as never; } },
      code: { run: async () => { seen.push("code-run"); return { status: "fail" } as never; } },
    },
  };
}

test("an e2e run validates through the e2e gate and may autofix", async () => {
  const seen: string[] = [];
  const api = buildTestExecution(deps("e2e", seen));

  const result = await api.validation.validate("/spec");
  const fixed = await api.validation.autofix?.("/spec", { deliveredSpecs: ["a.spec.ts"] } as never);

  assert.equal(result.ok, true);
  assert.deepEqual(fixed, ["a.spec.ts"]);
  assert.deepEqual(seen, ["e2e-validate", "e2e-autofix"]);
});

test("a code run validates through the code strategy and rewrites nothing", async () => {
  const seen: string[] = [];
  const api = buildTestExecution(deps("code", seen));

  const result = await api.validation.validate("/spec", ["a.ts"]);
  const fixed = await api.validation.autofix?.("/spec", {} as never);

  assert.deepEqual(result.errors, ["boom"]);
  assert.deepEqual(fixed, []);
  assert.deepEqual(seen, ["code-validate"]);
});

test("the execution port runs the strategy of the run's target", async () => {
  const seen: string[] = [];
  const api = buildTestExecution(deps("code", seen));

  await api.execution.execute("/spec").catch(() => undefined);

  assert.deepEqual(seen, ["code-run"]);
});
