import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { labelFailure, MAX_CAUSAL_CASES, type CausalInput, type CausalMatchers, type CausalScope } from "@contexts/objective-signal/domain/causal-label.ts";
import { requestServesOperation } from "@contexts/service-topology/domain/operation-url-pattern.ts";
import { namesTemplatePage } from "@contexts/generation/domain/route-instantiation.ts";
import type { EntryPoint } from "@kernel/change-reach.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const matchers: CausalMatchers = {
  servesOperation: requestServesOperation,
  namesPage: (route, pathname) => namesTemplatePage(route, pathname),
};

const op = (verb: string, path: string): EntryPoint => ({ kind: "operation", repo: "api", verb, path });
const page = (route: string): EntryPoint => ({ kind: "page", repo: "web", route });

function scope(over: Partial<CausalScope> = {}, reach: EntryPoint[] = [op("GET", "/shops/{id}")], known: EntryPoint[] = [op("GET", "/shops/{id}"), op("GET", "/orders/{id}"), page("/shops/:id"), page("/about")]): CausalScope {
  return {
    repos: [{ repo: "api", entryPoints: known, entryPointsTruncated: false }],
    reach: reach.map((entry) => ({ entry })),
    hubs: [],
    omitted: 0,
    degraded: [],
    ...over,
  };
}

const failed = (over: Partial<QaCase> = {}): QaCase => ({ name: "t", status: "fail", ...over });
const request = (path: string, status = 500): QaCase["networkErrors"] => [{ url: `https://dev.example${path}`, status }];
const run = (cases: QaCase[], s: CausalScope | undefined, flows: CausalInput["flows"] = []) => labelFailure({ cases, scope: s, flows, matchers });

describe("labelFailure", () => {
  it("labels a 5xx on an operation the change reaches as in reach by request", () => {
    const label = run([failed({ networkErrors: request("/api/shops/42") })], scope());
    assert.equal(label?.reach, "in-reach");
    assert.equal(label?.basis, "request");
    assert.deepEqual(label?.via, ["GET /shops/{id}"]);
  });

  it("labels a 5xx on a known operation outside the reach as out of reach", () => {
    const label = run([failed({ networkErrors: request("/orders/7") })], scope());
    assert.equal(label?.reach, "out-of-reach");
    assert.equal(label?.basis, "request");
    assert.deepEqual(label?.via, ["GET /orders/{id}"]);
  });

  it("does not call the same 5xx out of reach when a repo's index degraded", () => {
    const label = run([failed({ networkErrors: request("/orders/7") })], scope({ degraded: [{ repo: "web" }] }));
    assert.equal(label?.reach, "unknown");
  });

  it("does not call a failure out of reach when the walk or the entry list was cut", () => {
    for (const cut of [{ omitted: 2 }, { hubs: [{ truncated: true }] }, { repos: [{ repo: "api", entryPoints: [op("GET", "/orders/{id}")], entryPointsTruncated: true }] }]) {
      assert.equal(run([failed({ networkErrors: request("/orders/7") })], scope(cut))?.reach, "unknown");
    }
  });

  it("does not call a failure out of reach when a hub the scope withheld names its entry point", () => {
    const hub = { hubs: [{ keys: ["GET /orders/{id}", "page /about"] }] };
    assert.equal(run([failed({ networkErrors: request("/orders/7") })], scope(hub))?.reach, "unknown");
    assert.equal(run([failed({ finalUrl: "https://dev.example/about" })], scope(hub))?.reach, "unknown");
  });

  it("still calls a failure out of reach when the scope's hubs name other entry points", () => {
    assert.equal(run([failed({ networkErrors: request("/orders/7") })], scope({ hubs: [{ keys: ["GET /shops/{id}"] }] }))?.reach, "out-of-reach");
  });

  it("does not call a failure out of reach when a walk the budget cut proved nothing", () => {
    assert.equal(run([failed({ networkErrors: request("/orders/7") })], scope({ walksTruncated: true }))?.reach, "unknown");
  });

  it("labels a failing page the change reaches as in reach by page", () => {
    const label = run([failed({ finalUrl: "https://dev.example/shops/42" })], scope({}, [page("/shops/:id")]));
    assert.equal(label?.reach, "in-reach");
    assert.equal(label?.basis, "page");
    assert.deepEqual(label?.via, ["page /shops/:id"]);
  });

  it("labels a failing known page outside the reach as out of reach", () => {
    const label = run([failed({ finalUrl: "https://dev.example/about" })], scope());
    assert.equal(label?.reach, "out-of-reach");
    assert.equal(label?.basis, "page");
  });

  it("labels a case with no request or page evidence by the flow written for the change", () => {
    const label = run([failed({ file: "flows/shop.spec.ts" })], scope(), [{ specFile: "e2e/flows/shop.spec.ts", candidates: ["uc-0000aaaa"] }]);
    assert.equal(label?.reach, "in-reach");
    assert.equal(label?.basis, "flow");
    assert.deepEqual(label?.via, ["uc-0000aaaa"]);
  });

  it("ignores a flow that cites no use case", () => {
    const label = run([failed({ file: "flows/shop.spec.ts" })], scope(), [{ specFile: "flows/shop.spec.ts", candidates: [] }]);
    assert.equal(label?.reach, "unknown");
  });

  it("labels a failing case with no evidence unknown", () => {
    const label = run([failed()], scope());
    assert.deepEqual([label?.reach, label?.basis, label?.via], ["unknown", "none", []]);
  });

  it("matches the most specific evidence first: a request outranks the flow", () => {
    const label = run([failed({ file: "flows/shop.spec.ts", networkErrors: request("/orders/7") })], scope(), [{ specFile: "flows/shop.spec.ts", candidates: ["uc-1"] }]);
    assert.equal(label?.reach, "out-of-reach");
    assert.equal(label?.basis, "request");
  });

  it("is in reach at run level when any failed case is", () => {
    const label = run([failed({ name: "a", networkErrors: request("/orders/7") }), failed({ name: "b", networkErrors: request("/shops/1") })], scope());
    assert.equal(label?.reach, "in-reach");
    assert.deepEqual(label?.cases.map((c) => c.reach), ["out-of-reach", "in-reach"]);
  });

  it("is out of reach at run level only when every failed case is, and unknown when one has no evidence", () => {
    const outside = failed({ networkErrors: request("/orders/7") });
    assert.equal(run([outside, failed({ finalUrl: "https://dev.example/about" })], scope())?.reach, "out-of-reach");
    assert.equal(run([outside, failed()], scope())?.reach, "unknown");
  });

  it("has no label when no case failed", () => {
    assert.equal(run([{ name: "ok", status: "pass" }, { name: "f", status: "flaky" }], scope()), undefined);
  });

  it("is unknown without a scope, still labelling by flow", () => {
    assert.equal(run([failed({ networkErrors: request("/shops/1") })], undefined)?.reach, "unknown");
    assert.equal(run([failed({ file: "a.spec.ts" })], undefined, [{ specFile: "a.spec.ts", candidates: ["uc-1"] }])?.basis, "flow");
  });

  it("bounds the cases it lists", () => {
    const many = Array.from({ length: MAX_CAUSAL_CASES + 5 }, (_, i) => failed({ name: `c${i}` }));
    assert.equal(run(many, scope())?.cases.length, MAX_CAUSAL_CASES);
  });
});
