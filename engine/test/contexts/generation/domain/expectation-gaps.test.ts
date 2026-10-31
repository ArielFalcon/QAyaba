/* A field the consumer's own code expects of an operation that no live response of it carries at any depth is a gap, classified by the provider's contract. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findExpectationGaps, MAX_GAPS_PER_PAGE, type PageShapes } from "@contexts/generation/domain/expectation-gaps.ts";
import type { ConsumerExpectationsOf, ExpectedField, OperationExpectation } from "@contexts/generation/domain/consumer-expectation.ts";
import type { DataShape } from "@contexts/generation/domain/route-snapshot.ts";
import { dataContradictionStatement } from "@kernel/data-contradiction.ts";

const THINGS = "https://app.example/api/things";
const OTHER = "https://app.example/api/other";

const shape = (url: string, items: number, names: string[], opts: { method?: string; complete?: boolean } = {}): DataShape => ({ method: opts.method ?? "GET", url, items, keys: names, names, complete: opts.complete ?? true });
const page = (shapes: DataShape[], extra: Partial<PageShapes> = {}): PageShapes => ({ route: "/browse", shapes: { listed: shapes, omitted: 0 }, ...extra });

const field = (name: string, reads = [{ file: "src/view.ts", line: 3 }]): ExpectedField => ({ name, reads, readCount: reads.length });
const expecting = (...fields: ExpectedField[]): OperationExpectation => ({ callSites: [{ site: { file: "src/api.ts", line: 12 }, symbol: "list", declaredType: "Collection<Item>", fields }], fields });
const only = (path: string, expectation: OperationExpectation | undefined): ConsumerExpectationsOf => (request) => (request.path === path ? expectation : undefined);

test("a field the consumer expects that no live response of the operation carries is a gap, naming the operation, the call site, the type and where the field is read", () => {
  const found = findExpectationGaps([page([shape(THINGS, 3, ["id", "label"])])], { expectationsOf: only("/api/things", expecting(field("x"))) });
  assert.equal(found.facts.length, 1);
  const [fact] = found.facts;
  assert.equal(fact!.key, "x");
  assert.equal(fact!.operation, `GET ${THINGS}`);
  assert.equal(fact!.items, 3);
  assert.deepEqual(fact!.consumer, { callSite: "src/api.ts:12", callSites: 1, declaredType: "Collection<Item>", reads: ["src/view.ts:3"], readCount: 1 });
  assert.match(dataContradictionStatement(fact!), /expects it/);
});

test("a name the answer carries at any depth is carried, however deep", () => {
  const found = findExpectationGaps([page([shape(THINGS, 2, ["features", "id", "properties", "x"])])], { expectationsOf: only("/api/things", expecting(field("x"))) });
  assert.deepEqual(found.facts, []);
});

test("an operation with no expectation, one with no items, an incomplete shape and a write have no gap", () => {
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 3, ["id"])])], { expectationsOf: only("/api/things", undefined) }).facts, []);
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 0, [])])], { expectationsOf: only("/api/things", expecting(field("x"))) }).facts, []);
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 3, ["id"], { complete: false })])], { expectationsOf: only("/api/things", expecting(field("x"))) }).facts, []);
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 3, ["id"], { method: "POST" })])], { expectationsOf: only("/api/things", expecting(field("x"))) }).facts, []);
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 3, ["id"])])], {}).facts, []);
});

test("the operation's responses on every page count: a name another page's responses of it carry, or an incomplete one there, leaves no gap", () => {
  const sources = { expectationsOf: only("/api/things", expecting(field("x"))) };
  const gap = findExpectationGaps([page([shape(THINGS, 1, ["id"])], { route: "/a" }), page([shape(THINGS, 1, ["id"])], { route: "/b" })], sources);
  assert.deepEqual(gap.facts.map((f) => f.route), ["/a", "/b"]);
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 1, ["id"])], { route: "/a" }), page([shape(THINGS, 1, ["id", "x"])], { route: "/b" })], sources).facts, []);
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 1, ["id"])], { route: "/a" }), page([shape(THINGS, 1, ["id"], { complete: false })], { route: "/b" })], sources).facts, []);
});

test("the provider's contract classifies the gap: it does not declare the field, declares it, or none is known", () => {
  const expectationsOf = only("/api/things", expecting(field("x")));
  const classify = (fieldsOf: (method: string, url: string) => ReadonlySet<string> | undefined): string | undefined =>
    findExpectationGaps([page([shape(THINGS, 1, ["id"])])], { expectationsOf, fieldsOf }).facts[0]?.provider;
  assert.equal(classify(() => new Set(["id", "label"])), "provider-undeclared");
  assert.equal(classify(() => new Set(["id", "x"])), "provider-declared-absent");
  assert.equal(classify(() => undefined), "no-provider-contract");
  assert.equal(findExpectationGaps([page([shape(THINGS, 1, ["id"])])], { expectationsOf }).facts[0]?.provider, "no-provider-contract");
});

test("another operation of the page that carries the field is context on the gap, not a fact of its own", () => {
  const found = findExpectationGaps([page([shape(THINGS, 1, ["id"]), shape(OTHER, 4, ["id", "x"])])], { expectationsOf: only("/api/things", expecting(field("x"))) });
  assert.equal(found.facts.length, 1);
  assert.deepEqual(found.facts[0]!.alsoCarriedBy, [`GET ${OTHER}`]);
});

test("a gap carries no similarity rule: an operation that shares no keys with the one carrying the field is a gap all the same, and a look-alike with no expectation is none", () => {
  const found = findExpectationGaps([page([shape(THINGS, 1, ["only"]), shape(OTHER, 1, ["id", "label", "name", "price", "x"])])], { expectationsOf: only("/api/things", expecting(field("x"))) });
  assert.deepEqual(found.facts.map((f) => f.operation), [`GET ${THINGS}`]);
  assert.deepEqual(findExpectationGaps([page([shape(THINGS, 1, ["id", "label", "name", "price"]), shape(OTHER, 1, ["id", "label", "name", "price", "x"])])], { expectationsOf: only("/api/none", undefined) }).facts, []);
});

test("a page keeps the page's template, the facts come in the order of the pages, the shapes and then the key, and a page's facts are bounded and counted", () => {
  const fields = Array.from({ length: MAX_GAPS_PER_PAGE + 3 }, (_, i) => field(`f${String(i).padStart(3, "0")}`));
  const found = findExpectationGaps([page([shape(THINGS, 1, ["id"])], { route: "/shops/es", template: "/shops/:code" })], { expectationsOf: only("/api/things", expecting(...fields)) });
  assert.equal(found.facts.length, MAX_GAPS_PER_PAGE);
  assert.equal(found.omitted, 3);
  assert.equal(found.facts[0]!.template, "/shops/:code");
  assert.deepEqual(found.facts.map((f) => f.key), fields.slice(0, MAX_GAPS_PER_PAGE).map((f) => f.name));
  assert.equal(found.pages, 1);
});
