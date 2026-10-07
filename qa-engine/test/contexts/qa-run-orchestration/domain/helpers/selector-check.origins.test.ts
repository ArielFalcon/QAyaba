import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSpecSelectors, contradictionOrigins } from "@contexts/qa-run-orchestration/domain/helpers/selector-check.ts";

const SAVE = `await page.getByRole("button", { name: "Save" }).click();`;
const HOME = `await page.getByRole("link", { name: "Home" }).click();`;
const OWNERS = `await page.getByRole("heading", { name: "Owners" }).click();`;

/* The tree has a button (so a missing one is a verifiable absence), the home link once and the owners heading twice. */
const TREE = ["button: Cancel", "link: Home", "heading: Owners", "heading: Owners"];

test("each contradiction comes with the index of the spec that raised it", () => {
  const origins = contradictionOrigins([HOME, SAVE, OWNERS], [TREE]);
  assert.equal(origins.length, 2);
  assert.deepEqual(origins.map((origin) => origin.specIndex), [1, 2]);
  assert.match(origins[0]!.contradiction, /Save/);
  assert.match(origins[1]!.contradiction, /Owners/);
});

test("the contradictions are exactly the ones checkSpecSelectors finds, entry for entry and in the same order", () => {
  const specs = [OWNERS, HOME, SAVE, OWNERS];
  assert.deepEqual(
    contradictionOrigins(specs, [TREE]).map((origin) => origin.contradiction),
    checkSpecSelectors(specs, [TREE]).contradictions,
  );
});

test("a selector that two specs hold raises one contradiction for each: both are origins, the text is not collapsed", () => {
  const origins = contradictionOrigins([SAVE, HOME, SAVE], [TREE]);
  assert.deepEqual(origins.map((origin) => origin.specIndex), [0, 2]);
  assert.equal(origins[0]!.contradiction, origins[1]!.contradiction);
});

test("several contradictions of one spec all point at it, in the order of its source", () => {
  const both = `${SAVE} ${OWNERS}`;
  const origins = contradictionOrigins([HOME, both], [TREE]);
  assert.deepEqual(origins.map((origin) => origin.specIndex), [1, 1]);
  assert.match(origins[0]!.contradiction, /Save/);
  assert.match(origins[1]!.contradiction, /Owners/);
});

test("the tree label is the one asked for, and failure-point when none is", () => {
  const defaulted = contradictionOrigins([SAVE], [TREE]);
  const labelled = contradictionOrigins([SAVE], [TREE], "pre-write");
  assert.deepEqual(defaulted.map((origin) => origin.contradiction), checkSpecSelectors([SAVE], [TREE]).contradictions);
  assert.deepEqual(labelled.map((origin) => origin.contradiction), checkSpecSelectors([SAVE], [TREE], "pre-write").contradictions);
  assert.notEqual(defaulted[0]!.contradiction, labelled[0]!.contradiction);
});

test("specs that raise nothing, or no spec at all, give no origin", () => {
  assert.deepEqual(contradictionOrigins([HOME], [TREE]), []);
  assert.deepEqual(contradictionOrigins([], [TREE]), []);
  assert.deepEqual(contradictionOrigins([SAVE], []), []);
});
