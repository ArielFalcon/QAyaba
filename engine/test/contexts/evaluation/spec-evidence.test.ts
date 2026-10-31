import { test } from "node:test";
import assert from "node:assert/strict";
import { countPassedSpecs, deliveredSpecNames, deliveredSpecsOf, specCountsOf } from "@contexts/evaluation/domain/spec-evidence.ts";

const snapshot = (path: string, delivered = 1, capturedAt = 1) => ({ path, sha256: `sha-${path}-${capturedAt}`, text: "t", capturedAt, delivered });

test("a file that fits two specs fits neither", () => {
  const specs = ["e2e/a/x.spec.ts", "e2e/b/x.spec.ts"];
  assert.equal(countPassedSpecs(specs, [{ name: "t", status: "pass", file: "x.spec.ts" }], 2, "fail"), undefined);
  assert.equal(countPassedSpecs(specs, [{ name: "t", status: "pass", file: "a/x.spec.ts" }, { name: "u", status: "fail", file: "b/x.spec.ts" }], 2, "fail"), 1);
});

test("a spec left without cases makes the passed count unknown unless the run passed", () => {
  const cases = [{ name: "t", status: "pass", file: "a.spec.ts" }];
  assert.equal(countPassedSpecs(["a.spec.ts", "b.spec.ts"], cases, 2, "fail"), undefined);
  assert.equal(countPassedSpecs(["a.spec.ts", "b.spec.ts"], cases, 2, "pass"), 2);
  assert.equal(countPassedSpecs(["a.spec.ts"], cases, 0, "fail"), 0, "no valid spec passes none");
});

test("the record's own spec list wins whole, else the delivered snapshots name the specs once each", () => {
  const snapshots = [snapshot("flows/b.spec.ts"), snapshot("flows/a.spec.ts"), snapshot("flows/a.spec.ts"), snapshot("flows/gone.spec.ts", 0)];
  assert.deepEqual(deliveredSpecNames({ specs: [{ name: "flows/one.spec.ts" }] }, snapshots), ["flows/one.spec.ts"]);
  assert.deepEqual(deliveredSpecNames({}, snapshots), ["flows/a.spec.ts", "flows/b.spec.ts"]);
});

test("spec counts are a measurement only once the run got past validate; an invalid run has no valid spec", () => {
  const snapshots = [snapshot("flows/a.spec.ts")];
  assert.deepEqual(specCountsOf({ cases: [], verdict: "infra-error" }, snapshots, "generate"), { generated: 1, valid: null, passed: undefined });
  assert.deepEqual(specCountsOf({ cases: [], verdict: "invalid" }, snapshots, "validate"), { generated: 1, valid: 0, passed: 0 });
  assert.deepEqual(specCountsOf({ cases: [{ name: "t", status: "pass" as const, file: "a.spec.ts" }], verdict: "pass" }, snapshots, "execute"), { generated: 1, valid: 1, passed: 1 });
});

test("a delivered spec carries its newest delivered bytes and passes only when every case tied to it passed an executed run", () => {
  const snapshots = [snapshot("flows/a.spec.ts", 1, 1), snapshot("flows/a.spec.ts", 1, 5), snapshot("flows/a.spec.ts", 0, 9)];
  const cases = [{ name: "x", status: "pass" as const, file: "a.spec.ts" }, { name: "y", status: "fail" as const, file: "a.spec.ts" }];
  assert.deepEqual(deliveredSpecsOf(["flows/a.spec.ts"], snapshots, { cases, verdict: "fail" }), [{ path: "flows/a.spec.ts", sha256: "sha-flows/a.spec.ts-5", passed: false }]);
  assert.equal(deliveredSpecsOf(["flows/a.spec.ts"], snapshots, { cases, verdict: "infra-error" })[0]?.passed, undefined, "a run that did not execute says nothing about passing");
});
