/* Whether a regeneration a surviving mutant drove made a test notice it: each survivor is re-run against the changed specs it was routed to, and the closure counts what was judged, closed and still open. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { survivorClosureOf, survivorRechecks } from "@contexts/objective-signal/domain/survivor-closure.ts";
import type { MutationSite, SurvivedMutant } from "@contexts/objective-signal/domain/coverage-collector.ts";
import type { ObservedDifference } from "@kernel/observed-difference.ts";

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

const survived = (line: number, specFiles: string[], movedBySpec?: SurvivedMutant["movedBySpec"]): SurvivedMutant => ({ file: "src/store.ts", line, operator: "negate condition", specFiles, ...(movedBySpec ? { movedBySpec } : {}) });
const MOVED: ObservedDifference = { kind: "moved", requests: { added: ["GET https://dev.example/api/x"], removed: [] }, dom: { added: [], removed: [] }, tests: ["t"] };

test("each survivor keeps its mutant and is re-run only against the changed specs its finding was routed to, once each", () => {
  const routed = [
    { site: site(3), specFiles: ["flows/a.spec.ts", "flows/list.spec.ts"], tests: ["flows-a-x"] },
    { site: site(5), specFiles: ["flows/b.spec.ts", "flows/a.spec.ts"] },
  ];
  const findings = [
    survived(3, ["flows/a.spec.ts", "flows/list.spec.ts"], [{ spec: "flows/a.spec.ts", moved: MOVED }, { spec: "flows/list.spec.ts", moved: { kind: "unmoved", tests: 1 } }]),
    survived(5, ["flows/b.spec.ts", "flows/a.spec.ts"]),
  ];

  const rechecks = survivorRechecks(routed, findings, ["flows/list.spec.ts", "flows/b.spec.ts", "flows/a.spec.ts", "flows/b.spec.ts"]);

  assert.deepEqual(rechecks, [
    { site: site(3), specFiles: ["flows/a.spec.ts"] },
    { site: site(5), specFiles: ["flows/a.spec.ts", "flows/b.spec.ts"] },
  ]);
});

test("a survivor whose routed specs the regeneration did not change is not re-run, and one routed to no spec may be answered in any changed spec", () => {
  const rechecks = survivorRechecks(
    [{ site: site(3), specFiles: ["flows/c.spec.ts"] }, { site: site(5), specFiles: [] }],
    [survived(3, ["flows/c.spec.ts"]), survived(5, [])],
    ["flows/b.spec.ts", "flows/a.spec.ts"],
  );

  assert.deepEqual(rechecks, [{ site: site(5), specFiles: ["flows/a.spec.ts", "flows/b.spec.ts"] }]);
});

test("the closure counts the judged survivors, those a test now notices, and lists the rest by place and operator only", () => {
  const closure = survivorClosureOf(3, { applied: 2, killed: 1, survived: [{ file: "src/store.ts", line: 5, operator: "negate condition", original: "x", replacement: "!x", specFiles: ["flows/a.spec.ts"] }] });

  assert.deepEqual(closure, { routed: 3, judged: 2, closed: 1, open: [{ file: "src/store.ts", line: 5, operator: "negate condition" }] });
});

test("a re-run that judged nothing leaves every routed survivor neither closed nor open", () => {
  assert.deepEqual(survivorClosureOf(2, null), { routed: 2, judged: 0, closed: 0, open: [] });
});

test("a survivor whose re-run could not be read is counted apart: neither judged, closed nor open", () => {
  assert.deepEqual(survivorClosureOf(2, { applied: 1, killed: 0, survived: [], unreadable: 1 }), { routed: 2, judged: 1, closed: 0, open: [], unreadable: 1 });
  assert.deepEqual(survivorClosureOf(1, { applied: 0, killed: 0, survived: [], unreadable: 1 }), { routed: 1, judged: 0, closed: 0, open: [], unreadable: 1 });
});
