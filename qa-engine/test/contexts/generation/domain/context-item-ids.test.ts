/* The ids of what a grounding source supplies: the same item has the same id in every run, and the forms are the ones the design names. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ID_KIND,
  ID_KIND_EXTRACTABLE,
  MAX_ITEM_IDS,
  MAX_ITEM_ID_CHARS,
  advisoryLineIds,
  briefItemIds,
  capItemIds,
  changedValueFactIds,
  contextMapItemIds,
  domItemIds,
  domItemIdsBudgeted,
  hash8,
  itemId,
} from "@contexts/generation/domain/context-item-ids.ts";

const MAP = {
  routes: [{ path: "/orders" }, { path: "/orders/:id" }],
  api: [{ operationId: "listOrders" }],
  feBe: [{ route: "/orders", operationId: "listOrders" }],
  flows: [{ id: "checkout" }],
};

test("the map's routes, operations, links and flows get the forms the design names", () => {
  assert.deepEqual(contextMapItemIds(MAP), ["route:/orders", "route:/orders/:id", "op:listOrders", "link:/orders→listOrders", "flow:checkout"]);
});

test("a map that is read twice yields identical ids", () => {
  assert.deepEqual(contextMapItemIds(structuredClone(MAP)), contextMapItemIds(MAP));
});

test("a map without flows yields no flow ids", () => {
  const { flows: _flows, ...rest } = MAP;
  assert.equal(contextMapItemIds(rest).some((id) => id.startsWith("flow:")), false);
});

test("a rule and an exemplar are named by their own ids", () => {
  assert.equal(itemId.rule("r-12"), "rule:r-12");
  assert.equal(itemId.exemplar("form-submit"), "exemplar:form-submit");
});

test("a hash ignores case and spacing, and differs for another claim", () => {
  assert.equal(hash8("  Foo   BAR "), hash8("foo bar"));
  assert.notEqual(hash8("foo bar"), hash8("foo baz"));
  assert.match(hash8("x"), /^[0-9a-f]{8}$/);
});

test("an element with a test id is named by it, and one without by its role and a hash of its name", () => {
  const ids = domItemIds([
    {
      route: "/orders",
      testIds: ["save-btn"],
      nodes: ["button: Save", "link: Help", "text: hello", "textbox: (present)"],
      testIdOfNode: new Map([["button: Save", "save-btn"]]),
    },
  ]);
  assert.deepEqual(ids, ["dom:/orders#save-btn", `dom:/orders#role:link:${hash8("Help")}`]);
});

test("a state suffix does not change a node's id", () => {
  const plain = domItemIds([{ route: "/a", nodes: ["checkbox: Remember me"] }]);
  const stated = domItemIds([{ route: "/a", nodes: ["checkbox: Remember me [checked]"] }]);
  assert.deepEqual(stated, plain);
});

test("a test id a change added is present where captured pages show it and absent when none does", () => {
  const pages = [{ route: "/a", testIds: ["x", "y"] }, { route: "/b", testIds: ["x"] }];
  assert.deepEqual(changedValueFactIds(pages, ["x", "z"]), ["fact:/a#x:present", "fact:/b#x:present", "fact:*#z:absent"]);
});

test("a brief's claims are named by kind and a hash, so a reworded claim has another id and the same claim the same", () => {
  const brief = { routes: [{ path: "/a" }], risks: ["Stale cache"], feBe: [{ route: "/a", operationId: "op1" }] };
  const first = briefItemIds(brief);
  assert.equal(first.length, 3);
  assert.ok(first.every((id) => /^brief:[a-z-]+:[0-9a-f]{8}$/.test(id)));
  assert.deepEqual(briefItemIds(structuredClone(brief)), first);
});

test("advisory lines are items and headings are not", () => {
  const ids = advisoryLineIds("### Blast radius\n- a.ts (fn)\n\n- b.ts (g)\n");
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => /^signal:[0-9a-f]{8}$/.test(id)));
});

test("a service link is named by its two ends", () => {
  const link = { from: { repo: "o/web", symbol: "call" }, to: { repo: "o/api", symbol: "handler" } };
  assert.equal(itemId.svcLink(link), "svc-link:o/web/call→o/api/handler");
  assert.equal(itemId.impact("contract-file", link), "impact:contract-file:o/web/call→o/api/handler");
});

test("an id holds no line break and is bounded, keeping a hash of the whole so two long ids stay distinct", () => {
  const a = itemId.route(`/${"a".repeat(500)}`);
  const b = itemId.route(`/${"a".repeat(499)}b`);
  assert.ok(a.length <= MAX_ITEM_ID_CHARS);
  assert.notEqual(a, b);
  assert.equal(itemId.rule("x\ny").includes("\n"), false);
});

test("the cap keeps the first ids in order, removes repeats and counts the rest", () => {
  const many = Array.from({ length: MAX_ITEM_IDS + 5 }, (_, i) => `rule:${i}`);
  const capped = capItemIds([...many, "rule:0"]);
  assert.equal(capped.ids.length, MAX_ITEM_IDS);
  assert.equal(capped.overflow, 5);
  assert.equal(capped.ids[0], "rule:0");
});

test("a budget shared among many pages still leaves each a few ids, and the overflow is counted per route", () => {
  const pages = Array.from({ length: 100 }, (_, i) => ({ route: `/r${i}`, testIds: Array.from({ length: 10 }, (_t, t) => `t${t}`) }));
  const { ids, overflow } = domItemIdsBudgeted(pages);
  assert.equal(ids.filter((id) => id.startsWith("dom:/r99#")).length, 5);
  assert.equal(overflow[99], 5);
  const few = domItemIdsBudgeted([{ route: "/a", testIds: ["x"] }, { route: "/b", testIds: ["y"] }]);
  assert.deepEqual(few.ids, ["dom:/a#x", "dom:/b#y"]);
  assert.deepEqual(few.overflow, [0, 0]);
});

test("every kind states whether a spec can be checked against it, and briefs, rules and facts cannot", () => {
  for (const kind of ID_KIND) assert.equal(typeof ID_KIND_EXTRACTABLE[kind], "boolean");
  for (const kind of ["brief", "rule", "fact", "exemplar"] as const) assert.equal(ID_KIND_EXTRACTABLE[kind], false);
  for (const kind of ["route", "dom", "op"] as const) assert.equal(ID_KIND_EXTRACTABLE[kind], true);
});
