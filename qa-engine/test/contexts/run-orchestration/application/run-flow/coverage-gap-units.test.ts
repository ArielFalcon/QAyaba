/* The gap of a change as the units the lead routes: each names its file, every unit is kept, and they are listed across use cases and files instead of in the order measured. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapUnits } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { flowOfFinding } from "@contexts/coordination/application/lead-correction.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

const seeded = (route: string, file: string) => pageCandidate(route, undefined, { seeds: [{ file, symbol: "*" }] });
const arm = (file: string, line: number) => ({ file, line, kind: "if", arm: "else" });

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
  const units = gapUnits([{ file: "src/store.ts", lines: [4, 5] }], [arm("src/store.ts", 7), arm("src/other.ts", 2)], [], ranBy);
  const flows = [
    { id: "cart", objective: "the cart", specFile: "flows/cart.spec.ts", sessionOpen: true, seedFiles: ["src/store.ts", "src/other.ts"] },
    { id: "login", objective: "sign in", specFile: "flows/login.spec.ts", sessionOpen: true, seedFiles: ["src/store.ts", "src/other.ts"] },
  ];
  assert.deepEqual(units.map((u) => flowOfFinding(u.finding, flows)), ["login", "login", "cart"], "a file no spec is recorded as running keeps the plan's order");
  assert.deepEqual(units.map((u) => u.finding.ranBy), [["flows/login.spec.ts"], ["flows/login.spec.ts"], undefined]);
});
