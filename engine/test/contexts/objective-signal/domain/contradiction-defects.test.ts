import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contradictionDefects } from "@contexts/objective-signal/domain/contradiction-defects.ts";
import type { CausalMatchers, CausalScope } from "@contexts/objective-signal/domain/causal-label.ts";
import { requestServesOperation } from "@contexts/service-topology/domain/operation-url-pattern.ts";
import { namesTemplatePage } from "@contexts/generation/domain/route-instantiation.ts";
import type { EntryPoint } from "@kernel/change-reach.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";

const matchers: CausalMatchers = { servesOperation: requestServesOperation, namesPage: (route, pathname) => namesTemplatePage(route, pathname) };

const op = (verb: string, path: string): EntryPoint => ({ kind: "operation", repo: "api", verb, path });
const page = (route: string): EntryPoint => ({ kind: "page", repo: "web", route });

const scope = (reach: EntryPoint[]): CausalScope => ({ repos: [{ repo: "web", entryPoints: reach, entryPointsTruncated: false }], reach: reach.map((entry) => ({ entry })), hubs: [], omitted: 0, degraded: [] });

const fact = (over: Partial<DataContradiction> = {}): DataContradiction => ({
  route: "/restaurants",
  key: "activeMenuCuisineType",
  operation: "GET https://dev.example/restaurants/countries/ES",
  items: 12,
  provider: "provider-undeclared",
  consumer: { callSite: "src/geo.service.ts:20", callSites: 1, declaredType: "GeoCollection", reads: ["src/chips.ts:8"], readCount: 1 },
  ...over,
});

const defects = (facts: DataContradiction[], s: CausalScope | undefined) => contradictionDefects({ facts, scope: s, matchers });

describe("contradictionDefects", () => {
  it("is a defect when the provider's contract does not declare the field and the page is one the change reaches", () => {
    const found = defects([fact()], scope([page("/restaurants")]));
    assert.deepEqual(found.map((d) => [d.fact.key, d.basis, d.via]), [["activeMenuCuisineType", "page", ["page /restaurants"]]]);
  });

  it("is a defect by request when the operation the field is read from is one the change reaches, on a page it does not", () => {
    const found = defects([fact({ route: "/elsewhere" })], scope([op("GET", "/restaurants/countries/{code}")]));
    assert.deepEqual(found.map((d) => [d.basis, d.via]), [["request", ["GET /restaurants/countries/{code}"]]]);
  });

  it("is a defect for the page of a template the change reaches", () => {
    const found = defects([fact({ route: "/shops/42", template: "/shops/:id" })], scope([page("/shops/:id")]));
    assert.equal(found.length, 1);
  });

  it("is not a defect when the contract declares the field (an optional field DEV's data lacks) or no contract is known", () => {
    const reach = scope([page("/restaurants")]);
    assert.deepEqual(defects([fact({ provider: "provider-declared-absent" }), fact({ provider: "no-provider-contract" })], reach), []);
  });

  it("is not a defect when the change does not reach the page or the operation, or there is no scope to say so", () => {
    assert.deepEqual(defects([fact()], scope([page("/about")])), []);
    assert.deepEqual(defects([fact()], undefined), []);
  });

  it("keeps the order of the facts and decides each on its own", () => {
    const found = defects([fact({ key: "a" }), fact({ key: "b", provider: "provider-declared-absent" }), fact({ key: "c" })], scope([page("/restaurants")]));
    assert.deepEqual(found.map((d) => d.fact.key), ["a", "c"]);
  });
});
