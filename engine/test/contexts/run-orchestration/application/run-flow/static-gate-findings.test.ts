/* The static gate's lint problems reach the lead as findings that cite the spec they are in, so each goes to the flow that owns it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { staticGateFindings, type BoundText } from "@contexts/run-orchestration/application/run-flow/phases/generation-services.ts";
import { flowOfFinding, type FlowUnderCorrection } from "@contexts/coordination/application/lead-correction.ts";
import type { GateDiagnostic } from "@contexts/test-execution/application/index.ts";

const bound: BoundText = (text) => text;
const flows: FlowUnderCorrection[] = [
  { id: "cart", objective: "the cart total", specFile: "flows/cart.spec.ts", sessionOpen: true },
  { id: "login", objective: "sign in works", specFile: "flows/login.spec.ts", sessionOpen: true },
];
const diagnostic = (file: string, over: Partial<GateDiagnostic> = {}): GateDiagnostic => ({ file, severity: "error", rule: "playwright/expect-expect", line: 3, column: 1, message: "Test has no assertions", ...over });

test("each error diagnostic is one finding that cites the suite-relative file it is in", () => {
  const findings = staticGateFindings({ errors: ["[lint] x"], diagnostics: [diagnostic("flows/cart.spec.ts"), diagnostic("flows/cart.spec.ts", { line: 9, rule: "other" })], untypedErrors: [] }, bound);
  assert.deepEqual(findings.map((f) => f.finding.spec), ["flows/cart.spec.ts", "flows/cart.spec.ts"]);
  assert.match(findings[1]!.finding.text, /flows\/cart\.spec\.ts:9:1/);
  assert.match(findings[1]!.finding.text, /other/);
});

test("a file with warnings only yields no finding", () => {
  const findings = staticGateFindings({ errors: [], diagnostics: [diagnostic("flows/cart.spec.ts", { severity: "warning" })], untypedErrors: [] }, bound);
  assert.deepEqual(findings, []);
});

test("an error in a file that is no spec of the suite cites no flow", () => {
  const findings = staticGateFindings({ errors: [], diagnostics: [diagnostic("auth.setup.ts"), diagnostic("../outside.spec.ts")], untypedErrors: [] }, bound);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.finding.spec), [undefined, undefined]);
});

test("errors in two specs route to the two flows that own them", () => {
  const findings = staticGateFindings({ errors: [], diagnostics: [diagnostic("flows/login.spec.ts"), diagnostic("flows/cart.spec.ts")], untypedErrors: [] }, bound);
  assert.deepEqual(findings.map((f) => flowOfFinding(f.finding, flows)), ["login", "cart"]);
});

test("an error with no typed form stays one finding that cites no flow", () => {
  const findings = staticGateFindings({ errors: ["[typecheck] boom"], untypedErrors: ["[typecheck] boom"], diagnostics: [] }, bound);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.finding.spec, undefined);
  assert.match(findings[0]!.finding.text, /boom/);
});

test("a gate that typed nothing reports every error as untyped", () => {
  const findings = staticGateFindings({ errors: ["a", "b"] }, bound);
  assert.equal(findings.length, 2);
});
