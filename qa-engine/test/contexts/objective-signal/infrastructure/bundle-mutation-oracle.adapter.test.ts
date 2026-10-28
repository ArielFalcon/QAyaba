/* The e2e mutation oracle: one re-run per mutant of the spec files that reached it, a mutant judged only when it reached a page and the re-run ran tests that passed before, killed when one of them fails. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts";
import type { MutantRun } from "@contexts/objective-signal/domain/coverage-collector.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const mutant = (line: number, specFiles = ["flows/a.spec.ts"]): MutantRun => ({
  site: {
    file: "src/store.ts",
    line,
    column: 4,
    operator: "negate condition",
    script: { url: "https://dev.example/main.js", sha256: "abc" },
    edit: { start: 10, end: 20, replacement: "!(x === 1)" },
    original: "x === 1",
    ranIn: ["flows-a-spec-ts-x-0-0.json"],
  },
  specFiles,
});

const pass = (name: string): QaCase => ({ name, status: "pass" });
const fail = (name: string): QaCase => ({ name, status: "fail" });

test("each mutant re-runs its spec files under its own namespace with its edit, and is killed when a test that passed before fails", async () => {
  const runs: Array<{ namespace: string; mutant: unknown; specFiles: string[] }> = [];
  const results = [{ verdict: "fail", cases: [fail("shows missing"), pass("other")] }, { verdict: "pass", cases: [pass("shows missing")] }];
  const oracle = new BundleMutationOracleAdapter(
    async ({ namespace, mutant: m, specFiles }) => {
      runs.push({ namespace, mutant: JSON.parse(m!), specFiles });
      return results[runs.length - 1]!;
    },
    () => 1,
    "https://dev.example",
  );

  const result = await oracle.measure([mutant(10), mutant(12, ["flows/b.spec.ts"])], "/e2e", "run-1", ["shows missing", "other"]);

  assert.deepEqual(result, {
    applied: 2,
    killed: 1,
    survived: [{ file: "src/store.ts", line: 12, operator: "negate condition", specFiles: ["flows/b.spec.ts"], original: "x === 1", replacement: "!(x === 1)" }],
    proofs: [{ namespace: "run-1-mut0", specFiles: ["flows/a.spec.ts"], url: "https://dev.example/main.js", sha256: "abc", edit: { start: 10, end: 20, replacement: "!(x === 1)" }, original: "x === 1" }],
    survivorRuns: [mutant(12, ["flows/b.spec.ts"])],
  }, "the killed mutant's proof names its re-run and the spec files whose tests failed; the survivor keeps the mutant as it ran, so it can be applied again");
  assert.deepEqual(runs.map((r) => [r.namespace, r.specFiles]), [["run-1-mut0", ["flows/a.spec.ts"]], ["run-1-mut1", ["flows/b.spec.ts"]]]);
  assert.deepEqual(runs[0]!.mutant, { url: "https://dev.example/main.js", sha256: "abc", start: 10, end: 20, replacement: "!(x === 1)" });
});

test("a mutant that reached no page, a re-run that could not run, and one that ran none of the passing tests are not judged; with none judged there is no result", async () => {
  const cases: Array<{ verdict: string; cases: QaCase[]; mutated: number | undefined }> = [
    { verdict: "pass", cases: [pass("t")], mutated: 0 },
    { verdict: "infra-error", cases: [], mutated: 1 },
    { verdict: "fail", cases: [fail("not-before")], mutated: 1 },
  ];
  let i = 0;
  const oracle = new BundleMutationOracleAdapter(async () => cases[i]!, () => cases[i++]!.mutated, "https://dev.example");

  assert.equal(await oracle.measure(cases.map((_, n) => mutant(n + 1)), "/e2e", "run", ["t"]), null);
});

test("a mutant whose counters could not be read is not judged and is counted apart from one that reached no page, whatever its failing cases say", async () => {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    /* The first re-run failed five tests, so it was killed if the counter had been read; the counter of the second says no response was mutated; the third counter is read and the mutant survives. */
    const reruns = [
      { cases: [fail("a"), fail("b")], mutated: undefined as number | undefined },
      { cases: [pass("a"), pass("b")], mutated: 0 },
      { cases: [pass("a"), pass("b")], mutated: 2 },
    ];
    let i = 0;
    const oracle = new BundleMutationOracleAdapter(async () => ({ verdict: "fail", cases: reruns[i]!.cases }), () => reruns[i++]!.mutated, "https://dev.example");

    const result = await oracle.measure([mutant(1), mutant(2), mutant(3)], "/e2e", "run", ["a", "b"]);

    assert.equal(result?.applied, 1, "only the mutant whose counter was read is judged");
    assert.equal(result?.killed, 0);
    assert.equal(result?.unreadable, 1, "the unreadable one is counted, apart from the one that reached no page");
    assert.equal(warnings.filter((w) => /reached no page/.test(w)).length, 1, "only the mutant that really reached none says so");
    const unreadable = warnings.filter((w) => /could not be read/.test(w));
    assert.equal(unreadable.length, 1, "the unreadable evidence is said on a line of its own");
    assert.match(unreadable[0]!, /src\/store\.ts:1/);
  } finally {
    warn.mock.restore();
  }
});

test("with no mutant judged and one unreadable the result still says so, so the unreadable evidence is never lost to a null", async () => {
  const oracle = new BundleMutationOracleAdapter(async () => ({ verdict: "fail", cases: [fail("t")] }), () => undefined, "https://dev.example");

  assert.deepEqual(await oracle.measure([mutant(1)], "/e2e", "run", ["t"]), { applied: 0, killed: 0, survived: [], unreadable: 1 });
});

test("no mutant, no passing test or no DEV address runs nothing", async () => {
  let ran = 0;
  const run = async () => {
    ran++;
    return { verdict: "pass", cases: [] };
  };
  assert.equal(await new BundleMutationOracleAdapter(run, () => 1, "https://dev.example").measure([], "/e2e", "run", ["t"]), null);
  assert.equal(await new BundleMutationOracleAdapter(run, () => 1, "https://dev.example").measure([mutant(1)], "/e2e", "run", []), null);
  assert.equal(await new BundleMutationOracleAdapter(run, () => 1, "").measure([mutant(1)], "/e2e", "run", ["t"]), null);
  assert.equal(ran, 0);
});

test("a surviving mutant keeps the spec files that reached it and the edit it made, on one line and cut", async () => {
  const long = `${"a".repeat(300)}\n  b`;
  const m = mutant(5);
  m.site.original = long;
  m.site.edit = { ...m.site.edit, replacement: `!(${long})` };
  const oracle = new BundleMutationOracleAdapter(async () => ({ verdict: "pass", cases: [pass("t")] }), () => 1, "https://dev.example");

  const result = await oracle.measure([m], "/e2e", "run", ["t"]);

  const [survivor] = result!.survived;
  assert.deepEqual(survivor!.specFiles, ["flows/a.spec.ts"]);
  assert.ok(!/\n/.test(survivor!.original!) && !/\n/.test(survivor!.replacement!), "single line");
  assert.ok(survivor!.original!.length <= 121 && survivor!.replacement!.length <= 121, "cut");
});

test("a mutant that names the tests that reached it hands them to the suite's mutation fixture, and one that names none re-runs every test of its spec files", async () => {
  const sent: Array<{ tests?: string[] }> = [];
  const oracle = new BundleMutationOracleAdapter(async ({ mutant: m }) => (sent.push(JSON.parse(m!)), { verdict: "pass", cases: [pass("t")] }), () => 1, "https://dev.example");

  await oracle.measure([{ ...mutant(10), tests: ["flows-a-spec-ts-x"] }, mutant(12)], "/e2e", "run", ["t"]);

  const [narrowed, whole] = sent;
  assert.deepEqual(narrowed?.tests, ["flows-a-spec-ts-x"]);
  assert.equal(whole !== undefined && "tests" in whole, false);
});
