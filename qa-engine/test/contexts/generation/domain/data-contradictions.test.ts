/* Two data sources of one captured page that disagree: the items of one carry a key the items of a source of the same kind carry in none. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findDataContradictions,
  MAX_CONTRADICTIONS_PER_PAGE,
  SAME_KIND_MIN_OVERLAP,
  SAME_KIND_MIN_SHARED_KEYS,
  type PageShapes,
} from "@contexts/generation/domain/data-contradictions.ts";
import type { DataShape } from "@contexts/generation/domain/route-snapshot.ts";

const ALL = "https://app.example/api/items";
const BY_REGION = "https://app.example/api/items/by-region/ES";
const COMMON = ["address", "id", "name", "price", "region"];

const shape = (url: string, items: number, keys: string[], opts: { method?: string; complete?: boolean } = {}): DataShape => ({ method: opts.method ?? "GET", url, items, keys, complete: opts.complete ?? true });
const page = (shapes: DataShape[], extra: Partial<PageShapes> = {}): PageShapes => ({ route: "/browse", shapes: { listed: shapes, omitted: 0 }, ...extra });

test("a key that one source's items carry and the items of a source of the same kind carry in none is a possible contradiction, naming both sources", () => {
  const { facts } = findDataContradictions([page([shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 12, COMMON)])]);
  assert.equal(facts.length, 1);
  const [fact] = facts;
  assert.equal(fact?.key, "category");
  assert.equal(fact?.route, "/browse");
  assert.deepEqual(fact?.carriedBy, { operation: `GET ${ALL}`, items: 40 });
  assert.deepEqual(fact?.missingFrom, { operation: `GET ${BY_REGION}`, items: 12 });
  assert.equal(fact?.schemaBacked, false);
});

test("a page opened from a template keeps the template on the fact", () => {
  const { facts } = findDataContradictions([page([shape(ALL, 3, [...COMMON, "category"]), shape(BY_REGION, 3, COMMON)], { template: "/browse/:region" })]);
  assert.equal(facts[0]?.template, "/browse/:region");
});

test("a source that is a deliberate projection of the other, with little in common, is no contradiction", () => {
  const projection = ["id", "name"];
  assert.ok(projection.length < SAME_KIND_MIN_SHARED_KEYS);
  assert.deepEqual(findDataContradictions([page([shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 12, projection)])]).facts, []);
});

test("a source sharing less of the other's keys than the overlap asks for is a different resource, not a contradiction", () => {
  const unrelated = Array.from({ length: 12 }, (_, i) => `unrelated${i}`);
  const wide = [...COMMON, "category", ...unrelated];
  const narrow = [...COMMON, "other"];
  /* The overlap that counts leaves the contested key out of both. */
  const overlap = COMMON.length / (new Set([...wide, ...narrow]).size - 1);
  assert.ok(overlap < SAME_KIND_MIN_OVERLAP);
  assert.deepEqual(findDataContradictions([page([shape(ALL, 5, wide), shape(BY_REGION, 5, narrow)])]).facts, []);
});

test("a key no source of the page carries is nothing to contradict", () => {
  assert.deepEqual(findDataContradictions([page([shape(ALL, 40, COMMON), shape(BY_REGION, 12, COMMON)])]).facts, []);
});

test("a source that returned no item says nothing about the key", () => {
  assert.deepEqual(findDataContradictions([page([shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 0, [])])]).facts, []);
});

test("a source whose keys are those of some of its items only cannot be said to lack a key", () => {
  assert.deepEqual(findDataContradictions([page([shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 5000, COMMON, { complete: false })])]).facts, []);
});

test("the same source is not compared with itself, and sources of different methods are not compared", () => {
  assert.deepEqual(findDataContradictions([page([shape(ALL, 4, [...COMMON, "category"]), shape(ALL, 4, COMMON)])]).facts, []);
  assert.deepEqual(findDataContradictions([page([shape(ALL, 4, [...COMMON, "category"]), shape(BY_REGION, 4, COMMON, { method: "POST" })])]).facts, []);
});

test("sources of different pages are not compared with each other", () => {
  const a: PageShapes = { route: "/browse", shapes: { listed: [shape(ALL, 4, [...COMMON, "category"])], omitted: 0 } };
  const b: PageShapes = { route: "/other", shapes: { listed: [shape(BY_REGION, 4, COMMON)], omitted: 0 } };
  assert.deepEqual(findDataContradictions([a, b]).facts, []);
});

test("the app's response schema for the source that lacks the key backs the fact when it declares the key", () => {
  const fieldsOf = (_method: string, url: string): ReadonlySet<string> | undefined => (url === BY_REGION ? new Set([...COMMON, "category"]) : undefined);
  const { facts } = findDataContradictions([page([shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 12, COMMON)])], fieldsOf);
  assert.equal(facts[0]?.schemaBacked, true);
});

test("a schema that does not declare the key says the source is not meant to carry it: no fact", () => {
  const fieldsOf = (): ReadonlySet<string> => new Set(COMMON);
  assert.deepEqual(findDataContradictions([page([shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 12, COMMON)])], fieldsOf).facts, []);
});

test("a schema that declares no fields backs nothing and removes nothing", () => {
  const fieldsOf = (): ReadonlySet<string> => new Set();
  const { facts } = findDataContradictions([page([shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 12, COMMON)])], fieldsOf);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.schemaBacked, false);
});

test("facts come in the order of the page's sources and then the key, whatever order the keys were reported in", () => {
  const { facts } = findDataContradictions([page([shape(ALL, 4, [...COMMON, "zone", "category"]), shape(BY_REGION, 4, COMMON)])]);
  assert.deepEqual(facts.map((f) => f.key), ["category", "zone"]);
});

test("when several sources carry the key, the one that returned the most items is named", () => {
  const small = "https://app.example/api/items/featured";
  const { facts } = findDataContradictions([page([shape(small, 2, [...COMMON, "category"]), shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 12, COMMON)])]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.carriedBy.operation, `GET ${ALL}`);
});

test("a page with more contradictions than the bound keeps the bound and counts the rest", () => {
  const many = Array.from({ length: MAX_CONTRADICTIONS_PER_PAGE + 3 }, (_, i) => `extra${String(i).padStart(3, "0")}`);
  /* Enough keys in common that the contested ones leave the overlap where it is. */
  const common = Array.from({ length: 200 }, (_, i) => `shared${String(i).padStart(3, "0")}`);
  const { facts, omitted } = findDataContradictions([page([shape(ALL, 4, [...common, ...many]), shape(BY_REGION, 4, common)])]);
  assert.equal(facts.length, MAX_CONTRADICTIONS_PER_PAGE);
  assert.equal(omitted, 3);
});

test("it reports how many pages it read shapes of", () => {
  const { pages } = findDataContradictions([page([shape(ALL, 1, COMMON)]), { route: "/empty", shapes: { listed: [], omitted: 0 } }]);
  assert.equal(pages, 1);
});
