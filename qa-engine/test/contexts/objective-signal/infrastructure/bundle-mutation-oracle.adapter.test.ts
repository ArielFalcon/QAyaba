/* The e2e mutation oracle: one re-run per mutant of the spec files that reached it, a mutant judged only when it reached a page and the re-run ran tests that passed before, killed when one of them fails. */
import { test } from "node:test";
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
      runs.push({ namespace, mutant: JSON.parse(m), specFiles });
      return results[runs.length - 1]!;
    },
    () => 1,
    "https://dev.example",
  );

  const result = await oracle.measure([mutant(10), mutant(12, ["flows/b.spec.ts"])], "/e2e", "run-1", ["shows missing", "other"]);

  assert.deepEqual(result, {
    applied: 2,
    killed: 1,
    survived: [{ file: "src/store.ts", line: 12, operator: "negate condition" }],
    proofs: [{ namespace: "run-1-mut0", specFiles: ["flows/a.spec.ts"], url: "https://dev.example/main.js", sha256: "abc", edit: { start: 10, end: 20, replacement: "!(x === 1)" }, original: "x === 1" }],
  }, "the killed mutant's proof names its re-run and the spec files whose tests failed");
  assert.deepEqual(runs.map((r) => [r.namespace, r.specFiles]), [["run-1-mut0", ["flows/a.spec.ts"]], ["run-1-mut1", ["flows/b.spec.ts"]]]);
  assert.deepEqual(runs[0]!.mutant, { url: "https://dev.example/main.js", sha256: "abc", start: 10, end: 20, replacement: "!(x === 1)" });
});

test("a mutant that reached no page, a re-run that could not run, and one that ran none of the passing tests are not judged; with none judged there is no result", async () => {
  const cases: Array<{ verdict: string; cases: QaCase[]; mutated: number | undefined }> = [
    { verdict: "pass", cases: [pass("t")], mutated: 0 },
    { verdict: "pass", cases: [pass("t")], mutated: undefined },
    { verdict: "infra-error", cases: [], mutated: 1 },
    { verdict: "fail", cases: [fail("not-before")], mutated: 1 },
  ];
  let i = 0;
  const oracle = new BundleMutationOracleAdapter(async () => cases[i]!, () => cases[i++]!.mutated, "https://dev.example");

  assert.equal(await oracle.measure(cases.map((_, n) => mutant(n + 1)), "/e2e", "run", ["t"]), null);
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
