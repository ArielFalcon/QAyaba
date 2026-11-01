import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationPortAdapter } from "@contexts/test-execution/infrastructure/adapters/validation-port.adapter.ts";
import { StaticGateAdapter, type StaticGateChecks } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import type { CheckResult, ValidationResult } from "@contexts/test-execution/domain/execution-strategy.ts";

function fakeChecks(validateAllResult: ValidationResult): StaticGateChecks {
  const ok: CheckResult = { ok: true, output: "" };
  return {
    typecheck: async () => ok,
    lint: async () => ok,
    listTests: async () => ok,
    checkManifest: async () => ok,
    validateAll: async () => validateAllResult,
  };
}

function e2eAdapter(validateAllResult: ValidationResult): ValidationPortAdapter {
  const e2e = new StaticGateAdapter(fakeChecks(validateAllResult));
  return new ValidationPortAdapter({ e2e });
}

test("validate() delegates to StaticGateAdapter.validateAll and returns {ok, errors, infra} verbatim", async () => {
  const adapter = e2eAdapter({ ok: true, errors: [], infra: false, diagnostics: [], untypedErrors: [] });

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.infra, false);
});

test("validate() surfaces a failing gate's errors and the infra flag unchanged", async () => {
  const adapter = e2eAdapter({
    ok: false,
    errors: ["tsc: Property 'foo' does not exist"],
    infra: false,
    diagnostics: [],
    untypedErrors: [],
  });

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["tsc: Property 'foo' does not exist"]);
  assert.equal(result.infra, false);
});

test("validate() surfaces infra:true when the gate's own failures are all infrastructure", async () => {
  const adapter = e2eAdapter({
    ok: false,
    errors: ["playwright: browser binary missing"],
    infra: true,
    diagnostics: [],
    untypedErrors: [],
  });

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.infra, true);
});

test("autofix() asks the e2e gate's linter for the run's delivered specs", async () => {
  const asked: Array<[string, readonly string[]]> = [];
  const checks = { ...fakeChecks({ ok: true, errors: [], infra: false, diagnostics: [], untypedErrors: [] }), autofix: async (dir: string, specs: readonly string[]) => { asked.push([dir, specs]); return [...specs]; } };
  const e2e = new ValidationPortAdapter({ e2e: new StaticGateAdapter(checks) });
  assert.deepEqual(await e2e.autofix("/m/e2e", { deliveredSpecs: ["flows/a.spec.ts"] }), ["flows/a.spec.ts"]);
  assert.deepEqual(asked, [["/m/e2e", ["flows/a.spec.ts"]]]);
});
