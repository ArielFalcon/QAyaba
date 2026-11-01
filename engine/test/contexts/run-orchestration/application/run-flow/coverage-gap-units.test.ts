/* The gap of a change as the units the lead routes: each names its file, every unit is kept, and they are listed across use cases and files instead of in the order measured. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapUnits } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { flowOfFinding } from "@contexts/coordination/application/lead-correction.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

const seeded = (route: string, file: string) => pageCandidate(route, undefined, { seeds: [{ file, symbol: "*" }] });
const arm = (file: string, line: number, column = 2) => ({ file, line, column, kind: "if", arm: "else" });

test("each unit of the gap names the changed file it is about, and an arm its line", () => {
  const units = gapUnits([{ file: "src/a.ts", lines: [3, 4] }], [arm("src/b.ts", 9)], []);
  assert.deepEqual(units.map((u) => [u.finding.file, u.finding.line]), [["src/a.ts", undefined], ["src/b.ts", 9]]);
  assert.ok(units.every((u) => u.finding.text === u.text));
});

test("every arm and every file of the gap is a unit, however many the gap holds", () => {
  const first = Array.from({ length: 30 }, (_, i) => arm("src/big.ts", i + 1));
  const uncovered = Array.from({ length: 14 }, (_, i) => ({ file: `src/file-${i}.ts`, lines: [1] }));
  const units = gapUnits(uncovered, [...first, arm("src/small.ts", 2), arm("src/other.ts", 5)], []);
  const files = units.map((u) => u.finding.file);
  assert.equal(units.length, 14 + 32);
  assert.ok(files.includes("src/small.ts") && files.includes("src/other.ts") && files.includes("src/file-13.ts"), "no unit is left out of the gap");
});

test("units of a gap are listed across the use cases they seed, one use case before a second unit of another", () => {
  const cart = seeded("/cart", "src/cart-0.ts");
  const crowd = Array.from({ length: 12 }, (_, i) => ({ file: `src/orders-${i}.ts`, lines: [1] }));
  const candidates = [...crowd.map((u, i) => seeded(`/orders${i}`, u.file)).map((c) => ({ ...c, id: "uc-orders" })), cart, seeded("/login", "src/login.ts")];
  const uncovered = [...crowd, { file: "src/login.ts", lines: [2] }, { file: "src/cart-0.ts", lines: [7] }];
  const units = gapUnits(uncovered, [], candidates);
  const files = units.map((u) => u.finding.file);
  assert.equal(units.length, 14);
  assert.deepEqual(files.slice(0, 3), ["src/orders-0.ts", "src/login.ts", "src/cart-0.ts"]);
});

test("a file a hub shares with a use case is listed under that use case, not with the files no use case holds", () => {
  const shop = { ...seeded("/shop", "src/shop.ts"), id: "uc-shop", sharedSeeds: [{ file: "src/store.ts", symbol: "load", pages: 9 }] };
  const cart = { ...seeded("/cart", "src/cart-a.ts"), id: "uc-cart", seeds: [{ file: "src/cart-a.ts", symbol: "*" }, { file: "src/cart-b.ts", symbol: "*" }] };
  const uncovered = ["src/shop.ts", "src/cart-a.ts", "src/cart-b.ts", "src/store.ts", "src/stray.ts"].map((file) => ({ file, lines: [1] }));
  const units = gapUnits(uncovered, [], [shop, cart]);
  assert.deepEqual(units.map((u) => u.finding.file), ["src/shop.ts", "src/cart-a.ts", "src/stray.ts", "src/store.ts", "src/cart-b.ts"]);
});

test("a unit about a file several flows hold goes to the flow whose spec's tests ran the file, not to the first flow of the plan", () => {
  const ranBy = [{ file: "src/store.ts", specFiles: ["flows/login.spec.ts"] }];
  const units = gapUnits([{ file: "src/store.ts", lines: [4, 5] }], [{ ...arm("src/store.ts", 7), evaluatedBy: ["flows/login.spec.ts"] }, arm("src/other.ts", 2)], [], ranBy);
  const flows = [
    { id: "cart", objective: "the cart", specFile: "flows/cart.spec.ts", sessionOpen: true, seedFiles: ["src/store.ts", "src/other.ts"] },
    { id: "login", objective: "sign in", specFile: "flows/login.spec.ts", sessionOpen: true, seedFiles: ["src/store.ts", "src/other.ts"] },
  ];
  assert.deepEqual(units.map((u) => flowOfFinding(u.finding, flows)), ["login", "login", "cart"], "a file no spec is recorded as running keeps the plan's order");
  assert.deepEqual(units.map((u) => u.finding.ranBy), [["flows/login.spec.ts"], ["flows/login.spec.ts"], undefined]);
});

test("a decision with several untaken arms is one unit that names them all, and two decisions of one line never give the same text", () => {
  const sw = (armLabel: string) => ({ file: "src/a.ts", line: 8, column: 2, kind: "switch", arm: armLabel });
  const fallback = (column: number) => ({ file: "src/a.ts", line: 9, column, kind: "logical", arm: "right of ?? evaluated" });
  const units = gapUnits([], [sw("case 'open'"), sw("default"), fallback(10), fallback(25)], []);

  assert.equal(units.length, 3);
  assert.ok(units[0]!.text.includes("case 'open'") && units[0]!.text.includes("default"));
  assert.equal(new Set(units.map((u) => u.text)).size, 3);
  assert.deepEqual(units.map((u) => [u.finding.file, u.finding.line]), [["src/a.ts", 8], ["src/a.ts", 9], ["src/a.ts", 9]]);
});

test("an arm's finding carries the spec files that evaluated its decision, not the ones that ran its file; a decision no spec evaluated carries none", () => {
  const ranBy = [{ file: "src/store.ts", specFiles: ["flows/cart.spec.ts", "flows/login.spec.ts"] }];
  const evaluated = { ...arm("src/store.ts", 7), evaluatedBy: ["flows/login.spec.ts"] };
  const never = arm("src/store.ts", 9);

  const units = gapUnits([{ file: "src/store.ts", lines: [3] }], [evaluated, never], [], ranBy);

  assert.deepEqual(units.map((u) => [u.finding.line, u.finding.ranBy]), [[undefined, ["flows/cart.spec.ts", "flows/login.spec.ts"]], [7, ["flows/login.spec.ts"]], [9, undefined]]);
});

test("a decision's unit carries its source line and what the run holds about where its file is reached, and nothing a flow is routed by changes", () => {
  const untaken = { ...arm("src/store.ts", 7), sourceLine: "    if (cuisine && props.activeMenuCuisineType !== cuisine) return false" };
  const telling = { reachOf: (file: string) => (file === "src/store.ts" ? ["data contradiction on /search (a defect of the run): GET /menus returned 12 items"] : []), boundSource: (line: string) => line };

  const [told] = gapUnits([], [untaken], [], [], [], telling);
  const [bare] = gapUnits([], [arm("src/store.ts", 7)], []);

  assert.ok(told!.text.startsWith(bare!.text), "what a unit said before is still said first");
  assert.match(told!.text, /Source line: "if \(cuisine && props\.activeMenuCuisineType !== cuisine\) return false"/);
  assert.match(told!.text, /about where this file is reached: data contradiction on \/search \(a defect of the run\)/);
  assert.deepEqual({ ...told!.finding, text: "" }, { ...bare!.finding, text: "" });
});

test("a unit about changed lines, or about a file the run holds no fact of, says nothing more than it did", () => {
  const telling = { reachOf: () => [], boundSource: (line: string) => line };

  const units = gapUnits([{ file: "src/a.ts", lines: [3] }], [arm("src/b.ts", 9)], [], [], [], telling);
  const before = gapUnits([{ file: "src/a.ts", lines: [3] }], [arm("src/b.ts", 9)], []);

  assert.deepEqual(units.map((u) => u.text), before.map((u) => u.text));
});
