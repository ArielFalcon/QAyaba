import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeContradictions } from "@contexts/qa-run-orchestration/domain/helpers/contradiction-attribution.ts";
import { checkSpecSelectors, contradictionOrigins, type ContradictionOrigin } from "@contexts/generation/domain/selector-check.ts";
import { checkPreExecGrounding, type RouteTree } from "@contexts/generation/domain/pre-exec-grounding.service.ts";

/* A contradiction names a selector, never the spec, and the checks know which spec raised it. Attribution reads that: the real checks' own output goes through it, so a spec that holds the same selector but raised nothing (on a page that has it, or a Lever-2 selector it scopes) is never named. */

const OWNERS_PAGE = `await page.goto("/owners");`;
const PAGE_ROOTED = `${OWNERS_PAGE} await page.getByRole("heading", { name: "Owners" }).click();`;
const UNRELATED = `${OWNERS_PAGE} await page.getByRole("link", { name: "Home" }).click();`;
const TWO_OWNERS: RouteTree[] = [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners", "link: Home"] }];

/** The attribution of what the pre-exec gate finds in these specs, whose files are named after their position. */
function preExecAttribution(specSources: string[], routes: RouteTree[]): string[] {
  const { corrections, origins } = checkPreExecGrounding({ specSources, routes });
  return attributeContradictions(corrections, origins, specSources.map((_, index) => `spec${index}.spec.ts`));
}

const GHOST = `${OWNERS_PAGE} await page.getByTestId("ghost-id").click();`;
const OWNERS_WITHOUT_GHOST: RouteTree[] = [{ route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map() }];

test("a test-id the page lacks is attributed to the spec that raised it", () => {
  assert.deepEqual(preExecAttribution([UNRELATED, GHOST], OWNERS_WITHOUT_GHOST), ["spec1.spec.ts"]);
});

test("a spec that uses a test-id the page has raised nothing and is not attributed", () => {
  const routes: RouteTree[] = [{ route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map([["ghost-id", 1]]) }];
  assert.deepEqual(preExecAttribution([GHOST, UNRELATED], routes), []);
});

test("a test-id that two specs lack is attributed to both, in the order of the specs", () => {
  assert.deepEqual(preExecAttribution([GHOST, UNRELATED, GHOST], OWNERS_WITHOUT_GHOST), ["spec0.spec.ts", "spec2.spec.ts"]);
});

test("a role ambiguity the pre-exec gate tells is advisory: it is attributed to no spec", () => {
  assert.deepEqual(preExecAttribution([UNRELATED, PAGE_ROOTED], TWO_OWNERS), []);
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
