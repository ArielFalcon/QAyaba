/* The mutants a run re-runs: only on changed lines a test reached, one per line, across the changed files in turn, each re-running the spec files whose tests reached it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MUTANTS, selectMutants, specFilesOf } from "@contexts/objective-signal/domain/select-mutants.ts";
import type { MutationSite } from "@contexts/objective-signal/domain/coverage-collector.ts";

const site = (file: string, line: number, column: number, ranIn = ["flows-a-spec-ts-x-0-0.json"], operator = "negate condition"): MutationSite => ({
  file,
  line,
  column,
  operator,
  script: { url: `https://dev.example/${file}.js`, sha256: "h" },
  edit: { start: column, end: column + 1, replacement: "!" },
  ranIn,
});

const changed = new Map([
  ["src/a.ts", new Set([10, 11, 12])],
  ["src/b.ts", new Set([5])],
]);

test("mutants are made only on changed lines a test reached, one per line, taken across the changed files in turn", () => {
  const sites = [
    site("src/a.ts", 10, 2),
    site("src/a.ts", 10, 9, undefined, "=== → !=="),
    site("src/a.ts", 11, 0),
    site("src/a.ts", 12, 0),
    site("src/a.ts", 40, 0),
    site("src/b.ts", 5, 0),
    site("src/c.ts", 1, 0),
    site("src/b.ts", 5, 4, []),
  ];

  const picked = selectMutants(sites, changed, ["flows/a.spec.ts"]).map((m) => [m.site.file, m.site.line, m.site.column]);

  assert.equal(MAX_MUTANTS, 3);
  assert.deepEqual(picked, [["src/a.ts", 10, 2], ["src/b.ts", 5, 0], ["src/a.ts", 11, 0]]);
});

test("no site on a changed line that ran gives no mutant", () => {
  assert.deepEqual(selectMutants([site("src/a.ts", 99, 0), site("src/a.ts", 10, 0, [])], changed, ["flows/a.spec.ts"]), []);
});

test("a mutant re-runs the spec files whose tests' dumps ran it, told by the dump names, and every passing spec file when none can be told", () => {
  const files = ["flows/a.spec.ts", "flows/ab.spec.ts", "flows/b.spec.ts", "flows/a.spec.ts"];
  assert.deepEqual(specFilesOf(["flows-a-spec-ts-search-shows-results-0-0.json"], files), ["flows/a.spec.ts"], "flows/a is not flows/ab");
  assert.deepEqual(specFilesOf(["flows-a-spec-ts-x-0-0.json", "flows-b-spec-ts-y-1-0.json"], files), ["flows/a.spec.ts", "flows/b.spec.ts"]);
  assert.deepEqual(specFilesOf(["something-else-0-0.json"], files), ["flows/a.spec.ts", "flows/ab.spec.ts", "flows/b.spec.ts"]);

  const long = "flows/restaurant-detail/restaurant-detail-missing-state-after-load.spec.ts";
  const dump = `${long.replace(/[^a-z0-9]+/gi, "-")}-test`.slice(0, 60) + "-0-0.json";
  assert.deepEqual(specFilesOf([dump], [long, "flows/b.spec.ts"]), [long], "a path longer than the dump's title is told by its first characters");
});
