/* The links of a run as a graph over repositories: what enters and leaves a repo, the repos a hop walks next, and a walk that admits each link once. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkIdentity, type ImpactedLink, type ServiceLink } from "@kernel/service-links.ts";
import { LinkGraph, LinkWalk } from "@contexts/service-topology/domain/link-graph.ts";

const link = (from: string, to: string, symbol = "call"): ServiceLink => ({
  from: { repo: from, file: `${from}/src.ts`, symbol },
  to: { repo: to, file: `${to}/api.yaml`, symbol: "op" },
  transport: "http",
  confidence: 1,
  source: "test",
});
const impacted = (l: ServiceLink, over: Partial<ImpactedLink> = {}): ImpactedLink => ({ link: l, tier: "impacted-symbol", ...over });

const appToB = link("app", "b");
const bToC = link("b", "c");

test("the graph answers the links into and out of a repo in key order", () => {
  const graph = new LinkGraph([bToC, link("b", "c", "alpha"), appToB]);
  assert.deepEqual(graph.outOf("b").map((l) => l.from.symbol), ["alpha", "call"]);
  assert.deepEqual(graph.into("b"), [appToB]);
  assert.deepEqual(graph.into("app"), []);
});

test("a repo is onward when one of its outgoing links reaches a repo with outgoing links of its own", () => {
  assert.equal(new LinkGraph([appToB, bToC]).hasOnward("app"), true);
  assert.equal(new LinkGraph([appToB, bToC]).hasOnward("b"), false);
  assert.equal(new LinkGraph([appToB]).hasOnward("app"), false);
});

test("the next repos of an upstream hop are the origins of the fresh links that some link targets, each with the links that feed it", () => {
  const graph = new LinkGraph([appToB, bToC]);
  assert.deepEqual(graph.frontier("upstream", [impacted(bToC)]).map((f) => [f.repo, f.fed.map((x) => linkIdentity(x.link))]), [["b", [linkIdentity(bToC)]]]);
  assert.deepEqual(graph.frontier("upstream", [impacted(appToB)]), [], "nothing targets the app");
});

test("the next repos of a downstream hop are the targets of the fresh links that have links out", () => {
  const graph = new LinkGraph([appToB, bToC]);
  assert.deepEqual(graph.frontier("downstream", [impacted(appToB)]).map((f) => f.repo), ["b"]);
  assert.deepEqual(graph.frontier("downstream", [impacted(bToC)]), [], "c has no link out");
});

test("a walk admits each link once per direction, so a cycle of links ends", () => {
  const cToB = link("c", "b");
  const walk = new LinkWalk("upstream");
  assert.deepEqual(walk.admit([impacted(bToC)]).map((x) => linkIdentity(x.link)), [linkIdentity(bToC)]);
  assert.deepEqual(walk.admit([impacted(cToB), impacted(bToC)]).map((x) => linkIdentity(x.link)), [linkIdentity(cToB)]);
  assert.deepEqual(walk.admit([impacted(cToB)]), []);
});

const withOperation = (l: ServiceLink, symbol: string, verb: string, path: string): ServiceLink => ({ ...l, to: { ...l.to, symbol }, contractRef: symbol, operation: { verb, path } });

test("two links of one call site to two operations of one service are two links, to a graph and to a walk", () => {
  const list = withOperation(appToB, "list", "GET", "/orders");
  const get = withOperation(appToB, "get", "GET", "/orders/{id}");
  assert.notEqual(linkIdentity(list), linkIdentity(get));
  assert.deepEqual(new LinkGraph([list, get]).into("b").map((l) => l.contractRef), ["get", "list"]);
  assert.deepEqual(new LinkWalk("upstream").admit([impacted(list), impacted(get), impacted(list)]).map((x) => x.link.contractRef), ["get", "list"]);
});

test("two links that differ only by the verb or the path of the operation they call are two links", () => {
  assert.notEqual(linkIdentity(withOperation(appToB, "op", "GET", "/orders")), linkIdentity(withOperation(appToB, "op", "POST", "/orders")));
  assert.notEqual(linkIdentity(withOperation(appToB, "op", "GET", "/orders")), linkIdentity(withOperation(appToB, "op", "GET", "/orders/{id}")));
});
