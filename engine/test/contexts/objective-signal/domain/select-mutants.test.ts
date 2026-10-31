/* The mutants a run re-runs: only on changed lines a test reached whose source holds the expression a mutant changes, one per line, across the changed files in turn, each re-running the tests that reached it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MUTANTS, selectMutants, specFilesOf } from "@contexts/objective-signal/domain/select-mutants.ts";
import type { MutationSite } from "@contexts/objective-signal/domain/coverage-collector.ts";

/* A site of the served script whose expression is `x === y` (`x <op> y` for a swap of <op>), on a source line that holds it. */
const site = (file: string, line: number, column: number, ranIn = ["flows-a-spec-ts-x-0-0.json"], operator = "negate condition", texts: { original?: string; expression?: string; sourceLine?: string } = {}): MutationSite => {
  const swapped = operator.split(" → ")[1] === undefined ? undefined : operator.split(" → ")[0]!;
  const expression = swapped === undefined ? "x === y" : `x ${swapped} y`;
  return {
    file,
    line,
    column,
    operator,
    script: { url: `https://dev.example/${file}.js`, sha256: "h" },
    edit: { start: column, end: column + 1, replacement: "!" },
    original: texts.original ?? swapped ?? expression,
    expression: texts.expression ?? expression,
    ranIn,
    sourceLine: "sourceLine" in texts ? texts.sourceLine : `if (${expression}) return;`,
  };
};

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

  const picked = selectMutants(sites, changed, ["flows/a.spec.ts"]).mutants.map((m) => [m.site.file, m.site.line, m.site.column]);

  assert.equal(MAX_MUTANTS, 3);
  assert.deepEqual(picked, [["src/a.ts", 10, 2], ["src/b.ts", 5, 0], ["src/a.ts", 11, 0]]);
});

test("no site on a changed line that ran gives no mutant", () => {
  assert.deepEqual(selectMutants([site("src/a.ts", 99, 0), site("src/a.ts", 10, 0, [])], changed, ["flows/a.spec.ts"]).mutants, []);
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

test("the decisions of changed lines an arm of which no test ran come first, each by the site that forces it, before one mutant per line", () => {
  const sites = [
    site("src/a.ts", 10, 2),
    site("src/a.ts", 11, 0),
    site("src/a.ts", 12, 0, undefined, "=== → !=="),
    site("src/a.ts", 12, 6, undefined, "&& → ||"),
    site("src/b.ts", 5, 0),
  ];
  const decision = (file: string, line: number, column: number, kind: "if" | "logical", taken: boolean[]) => ({ file, line, column, kind, arms: taken.map((t, i) => ({ label: `arm ${i}`, taken: t })) });
  const decisions = [
    decision("src/a.ts", 10, 2, "if", [true, true]),
    decision("src/a.ts", 12, 6, "logical", [true, false]),
    decision("src/b.ts", 5, 0, "if", [false, true]),
  ];

  const picked = selectMutants(sites, changed, ["flows/a.spec.ts"], undefined, decisions).mutants.map((m) => [m.site.file, m.site.line, m.site.column, m.site.operator]);

  assert.deepEqual(picked, [
    ["src/a.ts", 12, 6, "&& → ||"],
    ["src/b.ts", 5, 0, "negate condition"],
    ["src/a.ts", 10, 2, "negate condition"],
  ], "the swap of the logical and the negation of the if first; a decision whose arms all ran is no target, and the fill skips the lines already taken");
});

test("a site whose source line does not hold the expression it mutates is no candidate, and each skip is counted by its reason", () => {
  /* A compiler-injected guard mapped to a changed line whose source holds no such expression. */
  const injected = "this.prefs.resolvedTheme() === 'dark' ? 'moon' : 'sun';";
  const sites = [
    site("src/a.ts", 10, 0, undefined, "negate condition", { original: "ngDevMode", expression: "ngDevMode", sourceLine: injected }),
    site("src/a.ts", 10, 4, undefined, "=== → !==", { original: "===", expression: 'typeof ngDevMode === "undefined"', sourceLine: injected }),
    site("src/a.ts", 11, 0, undefined, "== → !=", { original: "==", expression: "e == null", sourceLine: "const name = e?.name;" }),
    site("src/b.ts", 5, 0, undefined, "negate condition", { sourceLine: undefined }),
  ];

  const { mutants, skipped } = selectMutants(sites, changed, ["flows/a.spec.ts"]);

  assert.deepEqual(mutants, []);
  assert.equal(skipped.count, 4);
  assert.deepEqual(skipped.reasons, { "not-in-source-line": 3, "no-source-line": 1 });
});

test("a site whose source line holds the expression it mutates is a candidate, however the build reformatted it", () => {
  const source = "    const theme = this.prefs.resolvedTheme() === 'dark' ? 'moon' : 'sun';";
  const sites = [
    site("src/a.ts", 10, 0, undefined, "negate condition", { original: 't.prefs.resolvedTheme()==="dark"', expression: 't.prefs.resolvedTheme()==="dark"', sourceLine: source }),
    site("src/a.ts", 11, 0, undefined, "=== → !==", { original: "===", expression: 'this.prefs.resolvedTheme() === "dark"', sourceLine: source }),
  ];

  const { mutants, skipped } = selectMutants(sites, changed, ["flows/a.spec.ts"]);

  assert.deepEqual(mutants.map((m) => [m.site.line, m.site.operator]), [[10, "negate condition"], [11, "=== → !=="]]);
  assert.equal(skipped.count, 0);
});

test("the source line is asked of the reader for a site that carries none", () => {
  const asked: string[] = [];
  const sites = [site("src/a.ts", 10, 0, undefined, "negate condition", { sourceLine: undefined }), site("src/b.ts", 5, 0, undefined, "negate condition", { sourceLine: undefined })];
  const reader = (file: string, line: number) => (asked.push(`${file}:${line}`), file === "src/a.ts" ? "if (x === y) {" : "return;");

  const { mutants, skipped } = selectMutants(sites, changed, ["flows/a.spec.ts"], undefined, [], reader);

  assert.deepEqual(asked, ["src/a.ts:10", "src/b.ts:5"]);
  assert.deepEqual(mutants.map((m) => m.site.file), ["src/a.ts"]);
  assert.deepEqual(skipped.reasons, { "not-in-source-line": 1 });
});

test("a mutant re-runs only the tests whose dumps ran it, and the spec files' tests when its dumps do not name them", () => {
  const files = ["flows/a.spec.ts", "flows/b.spec.ts"];
  const named = site("src/a.ts", 10, 0, ["flows-a-spec-ts-search-shows-results-0-0.json", "flows-a-spec-ts-search-shows-results-1-0.json", "flows-a-spec-ts-filters-0-0.json"]);
  const unnamed = site("src/b.ts", 5, 0, ["something-else.json"]);

  const { mutants } = selectMutants([named, unnamed], changed, files);

  const [first, second] = mutants;
  assert.deepEqual(first?.specFiles, ["flows/a.spec.ts"]);
  assert.deepEqual(first?.tests, ["flows-a-spec-ts-filters", "flows-a-spec-ts-search-shows-results"]);
  assert.deepEqual(second?.specFiles, files);
  assert.equal(second?.tests, undefined, "no test can be told: every test of the spec files is re-run");
});
