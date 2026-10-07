/* EfficiencyBenchmarkCase format + validation.
   Mirrors coordination-benchmark.ts's own loader test conventions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIFF_TIER_NAMES } from "@contexts/generation/domain/diff-stat.ts";
import { loadEfficiencyBenchmarkCases } from "./efficiency-benchmark.ts";

test("loadEfficiencyBenchmarkCases: the tracked example set is a well-formed benchmark covering a plain, a ranged and a guided case", () => {
  const examplePath = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "benchmarks", "efficiency-cases.example.json");
  const cases = loadEfficiencyBenchmarkCases(examplePath);
  assert.ok(cases.length >= 3);
  assert.ok(cases.some((c) => c.baseSha !== undefined), "one example shows a commit range");
  assert.ok(cases.some((c) => c.guidance !== undefined), "one example shows guidance");
  assert.ok(cases.some((c) => c.name.includes("no-op")), "one example is a deliberate no-op, the case a step-exhausted run must never be mistaken for");
  assert.ok(cases.some((c) => c.tier !== undefined), "one example shows the optional tier");
  assert.ok(cases.some((c) => c.mode === "complete"), "one example is a complete-mode case, the kind the operator note asks for besides the diff cases");
  for (const c of cases) assert.match(c.sha, /^[0-9a-f]{7,40}$/);
});

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

test("loadEfficiencyBenchmarkCases: rejects two cases with the same name (results are keyed by case name)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "efficiency-cases.json");
  writeFileSync(
    badPath,
    JSON.stringify([
      { name: "same", app: "a", sha: "abc1234" },
      { name: "same", app: "a", sha: "def5678" },
    ]),
  );
  assert.throws(() => loadEfficiencyBenchmarkCases(badPath), /duplicate case name 'same'/);
});

test("loadEfficiencyBenchmarkCases: rejects a case with an invalid mode value", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "efficiency-cases.json");
  writeFileSync(badPath, JSON.stringify([{ name: "n", app: "a", sha: "s", mode: "not-a-real-mode" }]));
  assert.throws(() => loadEfficiencyBenchmarkCases(badPath), /must be a JSON array of EfficiencyBenchmarkCase objects/);
});

test("loadEfficiencyBenchmarkCases: rejects a sha or baseSha that is not a hex commit id, naming the case", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const bad of [
    { name: "branch-name", app: "demo", sha: "main" },
    { name: "too-short", app: "demo", sha: "abc12" },
    { name: "shell-ish", app: "demo", sha: "abc1234; rm -rf /" },
    { name: "bad-base", app: "demo", sha: "abc1234", baseSha: "HEAD~3" },
  ]) {
    const path = join(dir, "efficiency-cases.json");
    writeFileSync(path, JSON.stringify([bad]));
    assert.throws(() => loadEfficiencyBenchmarkCases(path), new RegExp(`case '${bad.name}'.*(sha|baseSha)`), bad.name);
  }
});

test("loadEfficiencyBenchmarkCases: accepts abbreviated and full hex ids in either letter case", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "efficiency-cases.json");
  writeFileSync(path, JSON.stringify([
    { name: "short", app: "demo", sha: "abc1234" },
    { name: "full", app: "demo", sha: "0123456789abcdef0123456789abcdef01234567", baseSha: "ABCDEF1" },
  ]));
  assert.deepEqual(loadEfficiencyBenchmarkCases(path).map((c) => c.name), ["short", "full"]);
});

test("loadEfficiencyBenchmarkCases: an empty baseSha means no range, as the service reads it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "efficiency-cases.json");
  writeFileSync(path, JSON.stringify([{ name: "no-range", app: "demo", sha: "abc1234", baseSha: "" }]));
  assert.deepEqual(loadEfficiencyBenchmarkCases(path).map((c) => c.name), ["no-range"]);
});

test("loadEfficiencyBenchmarkCases: the optional tier accepts every size class, and a case that declares none has none", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "efficiency-cases.json");
  writeFileSync(path, JSON.stringify([
    ...DIFF_TIER_NAMES.map((tier) => ({ name: `case-${tier}`, app: "demo", sha: "abc1234", tier })),
    { name: "case-undeclared", app: "demo", sha: "abc1234" },
  ]));
  assert.deepEqual(loadEfficiencyBenchmarkCases(path).map((c) => c.tier), [...DIFF_TIER_NAMES, undefined]);
});

test("loadEfficiencyBenchmarkCases: a tier that is not a size class is rejected, naming the case, the value and the size classes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "efficiency-cases.json");
  for (const bad of ["tinny", "TINY", ""]) {
    writeFileSync(path, JSON.stringify([{ name: "typo", app: "demo", sha: "abc1234", tier: bad }]));
    assert.throws(
      () => loadEfficiencyBenchmarkCases(path),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : "";
        assert.match(message, /case 'typo'/, `tier ${JSON.stringify(bad)}: names the case`);
        assert.ok(message.includes(JSON.stringify(bad)), `tier ${JSON.stringify(bad)}: carries the offending value`);
        for (const name of DIFF_TIER_NAMES) assert.ok(message.includes(name), `tier ${JSON.stringify(bad)}: lists the size class ${name}`);
        return true;
      },
    );
  }
});

test("loadEfficiencyBenchmarkCases: a tier that is not even a string fails the form check", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "efficiency-cases.json");
  for (const bad of [2, null, ["tiny"], { name: "tiny" }]) {
    writeFileSync(path, JSON.stringify([{ name: "typo", app: "demo", sha: "abc1234", tier: bad }]));
    assert.throws(() => loadEfficiencyBenchmarkCases(path), /must be a JSON array of EfficiencyBenchmarkCase objects/, JSON.stringify(bad));
  }
});
