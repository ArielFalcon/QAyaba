import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeContradictions } from "@contexts/qa-run-orchestration/domain/helpers/contradiction-attribution.ts";
import { checkSpecSelectors, contradictionOrigins, type ContradictionOrigin } from "@contexts/qa-run-orchestration/domain/helpers/selector-check.ts";
import { checkPreExecGrounding, type RouteTree } from "@contexts/qa-run-orchestration/domain/pre-exec-grounding.service.ts";

/* A contradiction names a selector, never the spec, and the checks know which spec raised it. Attribution reads that: the real checks' own output goes through it, so a spec that holds the same selector but raised nothing (scoped, disambiguated, or on a route that is fine) is never named. */

const OWNERS_PAGE = `await page.goto("/owners");`;
const PAGE_ROOTED = `${OWNERS_PAGE} await page.getByRole("heading", { name: "Owners" }).click();`;
const DISAMBIGUATED = `${OWNERS_PAGE} await page.getByRole("heading", { name: "Owners" }).first().click();`;
const SCOPED = `${OWNERS_PAGE} await page.locator("main").getByRole("heading", { name: "Owners" }).click();`;
const UNRELATED = `${OWNERS_PAGE} await page.getByRole("link", { name: "Home" }).click();`;
const TWO_OWNERS: RouteTree[] = [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners", "link: Home"] }];

/** The attribution of what the pre-exec gate finds in these specs, whose files are named after their position. */
function preExecAttribution(specSources: string[], routes: RouteTree[]): string[] {
  const { corrections, origins } = checkPreExecGrounding({ specSources, routes });
  return attributeContradictions(corrections, origins, specSources.map((_, index) => `spec${index}.spec.ts`));
}

test("an ambiguity is attributed to the spec that raised it", () => {
  assert.deepEqual(preExecAttribution([UNRELATED, PAGE_ROOTED], TWO_OWNERS), ["spec1.spec.ts"]);
});

test("a spec that holds the same selector disambiguated, or scoped to a parent, raised nothing and is not attributed", () => {
  assert.deepEqual(preExecAttribution([DISAMBIGUATED, PAGE_ROOTED, SCOPED], TWO_OWNERS), ["spec1.spec.ts"]);
  assert.deepEqual(preExecAttribution([DISAMBIGUATED, SCOPED], TWO_OWNERS), []);
});

test("an ambiguity that two specs raise is attributed to both, in the order of the specs", () => {
  assert.deepEqual(preExecAttribution([PAGE_ROOTED, UNRELATED, PAGE_ROOTED], TWO_OWNERS), ["spec0.spec.ts", "spec2.spec.ts"]);
});

test("a spec is attributed for the page it targets: the same selector where the page is fine is not", () => {
  const list = `await page.goto("/list"); await page.getByRole("button", { name: "Edit" }).click();`;
  const detail = `await page.goto("/detail"); await page.getByRole("button", { name: "Edit" }).click();`;
  const routes: RouteTree[] = [
    { route: "/list", nodes: Array(5).fill("button: Edit") },
    { route: "/detail", nodes: ["button: Edit"] },
  ];
  assert.deepEqual(preExecAttribution([detail, list], routes), ["spec1.spec.ts"]);
});

test("a test-id the page of one spec does not have is attributed to that spec, not to the one whose page has it", () => {
  const onPets = `await page.goto("/pets"); await page.getByTestId("owner-list").click();`;
  const onOwners = `await page.goto("/owners"); await page.getByTestId("owner-list").click();`;
  const routes: RouteTree[] = [
    { route: "/pets", nodes: [], status: "captured", settled: true, testIds: new Map() },
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map([["owner-list", 1]]) },
  ];
  assert.deepEqual(preExecAttribution([onOwners, onPets], routes), ["spec1.spec.ts"]);
});

test("an ambiguity and a test-id on different specs are both attributed, each to its own", () => {
  const ghost = `await page.goto("/pets"); await page.getByTestId("ghost-id").click();`;
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "heading: Owners"], status: "captured", settled: true, testIds: new Map() },
    { route: "/pets", nodes: [], status: "captured", settled: true, testIds: new Map() },
  ];
  assert.deepEqual(preExecAttribution([ghost, PAGE_ROOTED], routes), ["spec1.spec.ts", "spec0.spec.ts"]);
});

/* Lever-2: the FixLoop's check names the selector that is absent from, or matches several nodes of, the page it failed on. */
const SAVE = `await page.getByRole("button", { name: "Save" }).click();`;
const HOME = `await page.getByRole("link", { name: "Home" }).click();`;
const FAILURE_TREE = ["button: Cancel", "link: Home"];

test("a Lever-2 contradiction is attributed to the spec whose selector raised it", () => {
  const specs = [HOME, SAVE];
  const contradictions = checkSpecSelectors(specs, [FAILURE_TREE]).contradictions;
  assert.equal(contradictions.length, 1);
  assert.deepEqual(attributeContradictions(contradictions, contradictionOrigins(specs, [FAILURE_TREE]), ["home.spec.ts", "save.spec.ts"]), ["save.spec.ts"]);
});

test("a Lever-2 contradiction that two specs raise is attributed to both", () => {
  const specs = [SAVE, HOME, SAVE];
  const contradictions = checkSpecSelectors(specs, [FAILURE_TREE]).contradictions;
  assert.deepEqual(
    attributeContradictions(contradictions, contradictionOrigins(specs, [FAILURE_TREE]), ["a.spec.ts", "home.spec.ts", "c.spec.ts"]),
    ["a.spec.ts", "c.spec.ts"],
  );
});

/* The function itself, on origins written by hand. */
const origin = (contradiction: string, specIndex: number): ContradictionOrigin => ({ contradiction, specIndex });

test("only the contradictions asked for are attributed: the origins of the others are left out", () => {
  const origins = [origin("first", 0), origin("second", 1), origin("third", 2)];
  assert.deepEqual(attributeContradictions(["second"], origins, ["a.spec.ts", "b.spec.ts", "c.spec.ts"]), ["b.spec.ts"]);
  assert.deepEqual(attributeContradictions(["third", "first"], origins, ["a.spec.ts", "b.spec.ts", "c.spec.ts"]), ["a.spec.ts", "c.spec.ts"]);
});

test("a contradiction told once but raised by several specs is attributed to each of them", () => {
  const origins = [origin("same", 2), origin("other", 1), origin("same", 0)];
  assert.deepEqual(attributeContradictions(["same"], origins, ["a.spec.ts", "b.spec.ts", "c.spec.ts"]), ["c.spec.ts", "a.spec.ts"]);
});

test("the files come in the order of the origins, once each, in their canonical form", () => {
  const origins = [origin("x", 1), origin("y", 0), origin("x", 2), origin("y", 1)];
  assert.deepEqual(attributeContradictions(["x", "y"], origins, ["./a.spec.ts", "flows\\\\b.spec.ts", "flows//b.spec.ts"]), ["flows/b.spec.ts", "a.spec.ts"]);
});

test("an origin whose spec has no file, or a blank one, is attributed to none", () => {
  const origins = [origin("x", 0), origin("x", 1), origin("x", 5), origin("x", -1)];
  assert.deepEqual(attributeContradictions(["x"], origins, ["", "./"]), []);
  assert.deepEqual(attributeContradictions(["x"], origins, ["", "b.spec.ts"]), ["b.spec.ts"]);
});

test("nothing asked for, no origins or no files give an empty list", () => {
  const origins = [origin("x", 0)];
  assert.deepEqual(attributeContradictions([], origins, ["a.spec.ts"]), []);
  assert.deepEqual(attributeContradictions(["x"], [], ["a.spec.ts"]), []);
  assert.deepEqual(attributeContradictions(["x"], undefined, ["a.spec.ts"]), []);
  assert.deepEqual(attributeContradictions(["x"], origins, []), []);
});
