/* Whether a regeneration a surviving mutant drove made a test notice it: each survivor is re-run against the specs the regeneration changed, and the closure counts what was judged, closed and still open. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { survivorClosureOf, survivorRechecks } from "@contexts/objective-signal/domain/survivor-closure.ts";
import type { MutationSite } from "@contexts/objective-signal/domain/coverage-collector.ts";

const site = (line: number): MutationSite => ({
  file: "src/store.ts",
  line,
  column: 0,
  operator: "negate condition",
  script: { url: "https://dev.example/main.js", sha256: "abc" },
  edit: { start: 1, end: 2, replacement: "!" },
  original: "x",
  ranIn: ["flows-a-spec-ts-x-0.json"],
});

test("each survivor keeps its mutant and is re-run against every spec the regeneration changed, once each", () => {
  const rechecks = survivorRechecks([{ site: site(3), specFiles: ["flows/a.spec.ts"] }, { site: site(5), specFiles: [] }], ["flows/b.spec.ts", "flows/a.spec.ts", "flows/b.spec.ts"]);

  assert.deepEqual(rechecks, [
    { site: site(3), specFiles: ["flows/a.spec.ts", "flows/b.spec.ts"] },
    { site: site(5), specFiles: ["flows/a.spec.ts", "flows/b.spec.ts"] },
  ]);
});

test("the closure counts the judged survivors, those a test now notices, and lists the rest by place and operator only", () => {
  const closure = survivorClosureOf(3, { applied: 2, killed: 1, survived: [{ file: "src/store.ts", line: 5, operator: "negate condition", original: "x", replacement: "!x", specFiles: ["flows/a.spec.ts"] }] });

  assert.deepEqual(closure, { routed: 3, judged: 2, closed: 1, open: [{ file: "src/store.ts", line: 5, operator: "negate condition" }] });
});

test("a re-run that judged nothing leaves every routed survivor neither closed nor open", () => {
  assert.deepEqual(survivorClosureOf(2, null), { routed: 2, judged: 0, closed: 0, open: [] });
});
