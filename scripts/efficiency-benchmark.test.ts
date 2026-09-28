/* EfficiencyBenchmarkCase format + validation (design D14, tasks 1.10/5.4).
   Mirrors coordination-benchmark.ts's own loader test conventions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEfficiencyBenchmarkCases } from "./efficiency-benchmark.ts";

test("loadEfficiencyBenchmarkCases: a missing cases file throws a loud, actionable error (never a silent empty benchmark)", () => {
  assert.throws(
    () => loadEfficiencyBenchmarkCases("/nonexistent/efficiency-cases.json"),
    /efficiency benchmark cases not found at .*efficiency-cases\.json/,
  );
});

test("loadEfficiencyBenchmarkCases: a malformed cases file (missing required fields) throws loudly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "efficiency-cases.json");
  writeFileSync(badPath, JSON.stringify([{ name: "missing-app-and-sha" }]));
  assert.throws(() => loadEfficiencyBenchmarkCases(badPath), /must be a JSON array of EfficiencyBenchmarkCase objects/);
});

test("loadEfficiencyBenchmarkCases: a case file that is not a JSON array throws loudly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "efficiency-cases.json");
  writeFileSync(badPath, JSON.stringify({ name: "not-an-array" }));
  assert.throws(() => loadEfficiencyBenchmarkCases(badPath), /must be a JSON array of EfficiencyBenchmarkCase objects/);
});

test("loadEfficiencyBenchmarkCases: accepts a minimal case with only the required fields (name/app/sha)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const goodPath = join(dir, "efficiency-cases.json");
  writeFileSync(goodPath, JSON.stringify([{ name: "checkout-flow", app: "demo", sha: "abc1234" }]));
  const cases = loadEfficiencyBenchmarkCases(goodPath);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.name, "checkout-flow");
  assert.equal(cases[0]?.baseSha, undefined);
});

test("loadEfficiencyBenchmarkCases: accepts the optional baseSha/mode/target/guidance fields", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const goodPath = join(dir, "efficiency-cases.json");
  writeFileSync(
    goodPath,
    JSON.stringify([
      { name: "full-case", app: "demo", sha: "abc1234", baseSha: "def5678", mode: "manual", target: "code", guidance: "test checkout" },
    ]),
  );
  const cases = loadEfficiencyBenchmarkCases(goodPath);
  assert.equal(cases[0]?.baseSha, "def5678");
  assert.equal(cases[0]?.mode, "manual");
  assert.equal(cases[0]?.target, "code");
  assert.equal(cases[0]?.guidance, "test checkout");
});

test("loadEfficiencyBenchmarkCases: rejects a case with an invalid mode value", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "efficiency-cases.json");
  writeFileSync(badPath, JSON.stringify([{ name: "n", app: "a", sha: "s", mode: "not-a-real-mode" }]));
  assert.throws(() => loadEfficiencyBenchmarkCases(badPath), /must be a JSON array of EfficiencyBenchmarkCase objects/);
});
