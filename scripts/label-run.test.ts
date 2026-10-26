/* Labelling a run by hand: what it shows a person, and the human label it keeps beside the judge's score. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReferences, main, parseArguments, testTitles, type LabelRunDeps } from "./label-run.ts";
import type { LabelRow } from "./langfuse-labels.ts";
import { parseUseCaseReference } from "../qa-engine/src/contexts/evaluation/application/index.ts";

const PLAN = JSON.stringify({
  kind: "fanout",
  unvisited: ["/orders"],
  flows: [{ id: "cart", objective: "the cart total", acceptance: ["adds the fee"], visits: ["/cart"], outcome: { kind: "delivered" } }],
});

function rig(over: Partial<LabelRunDeps> = {}) {
  const lines: string[] = [];
  const saved: Array<{ rows: readonly LabelRow[]; at: string }> = [];
  const deps: LabelRunDeps = {
    getRecord: (id) => (id === "run-1" ? { app: "shop", sha: "abcdef1234567", verdict: "pass", cases: [{ name: "cart › shows the total", status: "pass", file: "flows/cart.spec.ts" }] } : undefined),
    getRunPlan: () => PLAN,
    deliveredSpecs: () => [{ path: "flows/cart.spec.ts", text: "test.describe('cart', () => { test('shows the total', async () => {}); });" }],
    scores: () => [{ name: "use_case_coverage", source: "llm_judge", value: false, comment: "uncovered: the fee" }, { name: "spec_pass_rate", source: "grader", value: 1, comment: null }],
    references: () => [parseUseCaseReference({ app: "shop", changes: [{ sha: "abcdef12", summary: "the cart adds a fee", useCases: [{ id: "fee", description: "the total adds the fee", reachability: "dev", routes: ["/cart"] }, { id: "down", description: "a failed total shows retry", reachability: "fault-injection", why: "only on a failed request" }] }] }, "shop.json")],
    save: (rows, at) => void saved.push({ rows, at }),
    sanitize: (text) => text.replaceAll("SECRET", "[redacted]"),
    now: () => "2026-10-25T12:00:00.000Z",
    out: (line) => void lines.push(line),
    ...over,
  };
  return { deps, lines, saved, text: () => lines.join("\n") };
}

test("show prints the plan, the delivered tests with their result, the reference use cases and the judges' critiques", () => {
  const r = rig();
  assert.equal(main(["--run", "run-1", "--show"], r.deps), 0);
  const text = r.text();
  assert.match(text, /commit abcdef1234567, verdict pass/);
  assert.match(text, /change pages no flow visits: \/orders/);
  assert.match(text, /flow cart \[delivered\]: the cart total\n {4}- adds the fee\n {4}visits: \/cart/);
  assert.match(text, /flows\/cart\.spec\.ts\n {4}test: shows the total \[pass\]/);
  assert.match(text, /reference: the cart adds a fee/);
  assert.match(text, /fee \[dev\]: the total adds the fee/);
  assert.match(text, /down \[fault-injection\]: a failed total shows retry \(only on a failed request\)/);
  assert.match(text, /use_case_coverage \(llm_judge\) = false: uncovered: the fee/);
  assert.doesNotMatch(text, /spec_pass_rate/, "a deterministic grader's score is not what a person compares against");
  assert.equal(r.saved.length, 0);
});

test("show says when the run kept no plan and its commit has no reference", () => {
  const r = rig({ getRunPlan: () => undefined, references: () => [] });
  main(["--run", "run-1", "--show"], r.deps);
  assert.match(r.text(), /plan: none kept/);
  assert.match(r.text(), /reference: no use cases for shop abcdef1234567/);
});

test("a label is kept as a human row typed by the judge of its name, with a sanitized comment", () => {
  const r = rig();
  assert.equal(main(["--run", "run-1", "--name", "use_case_coverage", "--value", "fail", "--comment", "fee uncovered SECRET"], r.deps), 0);
  assert.deepEqual(r.saved, [{ at: "2026-10-25T12:00:00.000Z", rows: [{ runId: "run-1", name: "use_case_coverage", graderVersion: "human", dataType: "BOOLEAN", polarity: "higher_better", source: "human", value: false, comment: "fee uncovered [redacted]", observationId: null }] }]);
  const numeric = rig();
  assert.equal(main(["--run", "run-1", "--name", "plan_route_coverage", "--value", "0.5"], numeric.deps), 0);
  assert.equal(numeric.saved[0]!.rows[0]!.value, 0.5);
});

test("a label the score cannot take, of an unknown score or of an unknown run is refused and nothing is kept", () => {
  for (const [argv, code, pattern] of [
    [["--run", "run-1", "--name", "use_case_coverage", "--value", "maybe"], 2, /pass or fail/],
    [["--run", "run-1", "--name", "plan_route_coverage", "--value", "2"], 2, /out of range/],
    [["--run", "run-1", "--name", "failure_root_cause", "--value", "gremlins"], 2, /not one of/],
    [["--run", "run-1", "--name", "made_up", "--value", "1"], 2, /neither a score/],
    [["--run", "run-9", "--name", "use_case_coverage", "--value", "pass"], 1, /no run run-9/],
  ] as const) {
    const r = rig();
    assert.equal(main(argv, r.deps), code, argv.join(" "));
    assert.match(r.text(), pattern);
    assert.equal(r.saved.length, 0);
  }
});

test("the arguments name a run and either --show or a label", () => {
  assert.deepEqual(parseArguments(["--run", "r", "--show"]), { ok: true, runId: "r", show: true });
  assert.deepEqual(parseArguments(["--run", "r", "--name", "n", "--value", "v"]), { ok: true, runId: "r", show: false, name: "n", value: "v" });
  assert.equal(parseArguments(["--show"]).ok, false);
  assert.equal(parseArguments(["--run", "r"]).ok, false);
  assert.equal(parseArguments(["--run", "r", "--show", "--name", "n"]).ok, false);
  assert.equal(parseArguments(["--run", "r", "--bogus"]).ok, false);
  const r = rig();
  assert.equal(main(["--run"], r.deps), 2);
  assert.match(r.text(), /usage: npm run label/);
});

test("test titles are read from a spec's test calls", () => {
  assert.deepEqual(testTitles(`test("a", () => {}); test.skip('b', () => {}); test.describe("group", () => {}); test(\`c\`, async () => {});`), ["a", "b", "c"]);
});

test("the reference sets of a directory are loaded, and a file that is not one names itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "use-cases-"));
  try {
    writeFileSync(join(dir, "shop.json"), JSON.stringify({ app: "shop", changes: [] }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    assert.deepEqual(loadReferences(dir).map((s) => s.app), ["shop"]);
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ changes: [] }));
    assert.throws(() => loadReferences(dir), /broken\.json: app is required/);
    assert.deepEqual(loadReferences(join(dir, "absent")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tracked example of a reference set is one", () => {
  const set = parseUseCaseReference(JSON.parse(readFileSync("config/benchmarks/use-cases.example.json", "utf8")), "use-cases.example.json");
  assert.ok(set.changes.length > 0);
});
