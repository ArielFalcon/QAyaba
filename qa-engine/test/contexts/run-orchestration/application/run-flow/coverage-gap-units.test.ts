/* The gap of a change as the units the lead routes: each names its file, and a cap spreads across use cases and files instead of keeping the first measured. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapUnits } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

const seeded = (route: string, file: string) => pageCandidate(route, undefined, { seeds: [{ file, symbol: "*" }] });
const arm = (file: string, line: number) => ({ file, line, kind: "if", arm: "else" });

test("each unit of the gap names the changed file it is about, and an arm its line", () => {
  const { units, omitted } = gapUnits([{ file: "src/a.ts", lines: [3, 4] }], [arm("src/b.ts", 9)], []);
  assert.equal(omitted, 0);
  assert.deepEqual(units.map((u) => [u.finding.file, u.finding.line]), [["src/a.ts", undefined], ["src/b.ts", 9]]);
  assert.ok(units.every((u) => u.finding.text === u.text));
});

test("arms are taken across files, not in the order measured, and the count the cap leaves out is stated", () => {
  const first = Array.from({ length: 30 }, (_, i) => arm("src/big.ts", i + 1));
  const { units, omitted } = gapUnits([], [...first, arm("src/small.ts", 2), arm("src/other.ts", 5)], []);
  const files = units.map((u) => u.finding.file);
  assert.equal(units.length, 20);
  assert.ok(files.includes("src/small.ts") && files.includes("src/other.ts"), "a file measured late is not crowded out");
  assert.equal(omitted, 32 - 20);
});

test("files with uncovered lines are taken across the use cases they seed", () => {
  const cart = seeded("/cart", "src/cart-0.ts");
  const crowd = Array.from({ length: 12 }, (_, i) => ({ file: `src/orders-${i}.ts`, lines: [1] }));
  const candidates = [...crowd.map((u, i) => seeded(`/orders${i}`, u.file)).map((c) => ({ ...c, id: "uc-orders" })), cart, seeded("/login", "src/login.ts")];
  const uncovered = [...crowd, { file: "src/login.ts", lines: [2] }, { file: "src/cart-0.ts", lines: [7] }];
  const { units, omitted } = gapUnits(uncovered, [], candidates);
  const files = units.map((u) => u.finding.file);
  assert.equal(units.length, 10);
  assert.ok(files.includes("src/login.ts") && files.includes("src/cart-0.ts"), "every use case gets a unit before one gets a second");
  assert.equal(omitted, 14 - 10);
});

test("a gap within the caps leaves nothing out", () => {
  assert.equal(gapUnits([{ file: "src/a.ts", lines: [1] }], [arm("src/a.ts", 1)], []).omitted, 0);
});
