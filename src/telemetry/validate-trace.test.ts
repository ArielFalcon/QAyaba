/* The static gate's checks as spans under the phase that is open. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countCheckErrors, firstCheckError, traceValidateDeps } from "../../qa-engine/src/contexts/test-execution/infrastructure/static-gate.trace";
import { validateSpecs, type ValidateDeps } from "../../qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import type { CheckResult } from "@contexts/test-execution/application/index.ts";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { traceHarness } from "./trace-harness";

const ok: CheckResult = { ok: true, output: "" };
const TSC_OUTPUT = "flows/a.spec.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nflows/b.spec.ts(9,1): error TS2304: Cannot find name 'x'.\n";
const ESLINT_OUTPUT = "/m/e2e/flows/a.spec.ts\n  4:3  error  Missing await  playwright/missing-playwright-await\n  9:1  warning  x  y\n\n✖ 2 problems (1 error, 1 warning)\n";

function fakeDeps(over: Partial<Record<keyof ValidateDeps, CheckResult>> = {}): ValidateDeps {
  return {
    typecheck: async () => over.typecheck ?? ok,
    lint: async () => over.lint ?? ok,
    listTests: async () => over.listTests ?? ok,
    checkManifest: async () => over.checkManifest ?? ok,
  };
}

function scopeWith(parent: () => import("@kernel/telemetry/telemetry.port").TelemetryContext | undefined): RunScope {
  return { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent } };
}

test("errors of a failed check are counted from the tool's own output", () => {
  assert.equal(countCheckErrors("typecheck", { ok: false, output: TSC_OUTPUT }), 2);
  assert.equal(countCheckErrors("lint", { ok: false, output: ESLINT_OUTPUT }), 1);
  assert.equal(countCheckErrors("list", { ok: false, output: "Error: No tests found\nError: boom" }), 2);
  assert.equal(countCheckErrors("manifest", { ok: false, output: "a: missing\n\nb: bad" }), 2);
  assert.equal(countCheckErrors("lint", ok), 0);
});

test("a failed check whose output no rule counts is one error", () => {
  assert.equal(countCheckErrors("typecheck", { ok: false, output: "something odd" }), 1);
});

test("each of the four checks is a span under the open phase with its outcome", async () => {
  const h = traceHarness();
  const phase = h.telemetry.startSpan("qayaba.phase.validate");
  const deps = traceValidateDeps(fakeDeps({ typecheck: { ok: false, output: TSC_OUTPUT }, listTests: { ok: false, output: "timed out", infra: true } }), h.telemetry);
  const gate = await withExecScope(scopeWith(() => phase.context()), () => validateSpecs("/nonexistent", deps));
  phase.end();

  const checks = h.named("qayaba.validate.check");
  assert.deepEqual(checks.map((s) => s.attributes["qayaba.validate.check"]).sort(), ["lint", "list", "manifest", "typecheck"]);
  for (const c of checks) assert.equal(c.parentSpanContext?.spanId, phase.context().spanId);
  const by = (name: string) => checks.find((s) => s.attributes["qayaba.validate.check"] === name)!;
  assert.equal(by("typecheck").attributes["qayaba.validate.ok"], false);
  assert.equal(by("typecheck").attributes["qayaba.validate.errors"], 2);
  assert.equal(by("typecheck").attributes["qayaba.validate.first_error"], "flows/a.spec.ts:3:5 TS2322");
  assert.equal(by("lint").attributes["qayaba.validate.first_error"], undefined);
  assert.equal(by("lint").attributes["qayaba.validate.ok"], true);
  assert.equal(by("lint").attributes["qayaba.validate.errors"], 0);
  assert.equal(by("list").attributes["qayaba.validate.infra"], true);
  assert.equal(gate.ok, false);
  assert.deepEqual(h.unended(), []);
});

test("the gate's verdict is the same with the checks traced, with none, and with a telemetry port that throws", async () => {
  const failing = fakeDeps({ lint: { ok: false, output: ESLINT_OUTPUT } });
  const plain = await validateSpecs("/nonexistent", failing);
  const traced = await validateSpecs("/nonexistent", traceValidateDeps(failing, traceHarness().telemetry));
  const broken = await validateSpecs("/nonexistent", traceValidateDeps(failing, new ThrowingTelemetry()));
  assert.deepEqual(traced, plain);
  assert.deepEqual(broken, plain);
});

test("a check that throws is recorded as an infrastructure failure and the exception goes on", async () => {
  const h = traceHarness();
  const deps = traceValidateDeps({ ...fakeDeps(), typecheck: async () => { throw new Error("spawn failed"); } }, h.telemetry);
  await assert.rejects(deps.typecheck("/x"), /spawn failed/);
  const span = h.only("qayaba.validate.check");
  assert.equal(span.status.code, 2);
});

test("a failed check names its first error: the file, the line and the rule or code", () => {
  assert.equal(firstCheckError("typecheck", { ok: false, output: TSC_OUTPUT }), "flows/a.spec.ts:3:5 TS2322");
  assert.equal(firstCheckError("lint", { ok: false, output: ESLINT_OUTPUT }), "/m/e2e/flows/a.spec.ts:4:3 playwright/missing-playwright-await");
  assert.equal(firstCheckError("lint", { ok: true, output: "" }), undefined);
  assert.equal(firstCheckError("list", { ok: false, output: "Error: no tests found" }), undefined);
});
