/* The pack says, as facts of the page, which fields the consumer's code expects of an answer the page received that the answer lacks; what the pack gave before is unchanged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, PACK_HEADINGS, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ConsumerExpectationsOf } from "@contexts/generation/domain/consumer-expectation.ts";
import type { CapturedPage } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { DataShape } from "@contexts/generation/domain/route-snapshot.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";

const ALL = "https://app.example/api/items";
const BY_REGION = "https://app.example/api/items/by-region/ES";
const COMMON = ["address", "id", "name", "price", "region"];

/* The consumer's code expects `category` of the answer to the by-region request: its call site declares a type that holds it, two files read it. */
const EXPECTS_CATEGORY: ConsumerExpectationsOf = (request) =>
  request.path === "/api/items/by-region/ES"
    ? { callSites: [{ site: { file: "src/api.ts", line: 12 }, symbol: "byRegion", declaredType: "Item[]", fields: [] }], fields: [{ name: "category", reads: [{ file: "src/list.ts", line: 4 }, { file: "src/card.ts", line: 9 }], readCount: 2 }] }
    : undefined;
const shape = (url: string, items: number, keys: string[]): DataShape => ({ method: "GET", url, items, keys, names: keys, complete: true });

function captureDeps(pages: CapturedPage[], report = "route /browse:\n  heading: Browse\nroute /home:\n  heading: Home"): ContextPackDeps {
  return {
    captureDomForRoutes: async (_routes, input) => {
      input.onPages?.(pages);
      return report;
    },
    domDeps: { render: async () => [] },
    log: () => {},
  };
}

const browse: CapturedPage = { route: "/browse", grounded: true, links: [], nodes: ["heading: Browse"], shapes: { listed: [shape(ALL, 40, [...COMMON, "category"]), shape(BY_REGION, 12, COMMON)], omitted: 0 } };
const home: CapturedPage = { route: "/home", grounded: true, links: [], nodes: ["heading: Home"] };
const input = { baseUrl: "http://dev.example", e2eDir: "/tmp/e2e", routes: ["/browse", "/home"] };

const sectionOf = (text: string | undefined): string => (text ?? "").split(/^### /m).find((part) => part.startsWith(PACK_HEADINGS.contradictions)) ?? "";

test("the pack states, per page, a field the consumer's code expects of an answer that no response of the operation carries, with the consumer's read sites and the provider's class", async () => {
  const pack = await buildContextPack({ ...input, consumerExpectations: EXPECTS_CATEGORY }, captureDeps([browse, home]));
  const section = sectionOf(pack.text);
  assert.ok(section.includes(`- /browse: GET ${BY_REGION} returned 12 items, none carrying "category" at any depth`));
  assert.ok(section.includes("src/api.ts:12 declares Item[]"));
  assert.ok(section.includes("src/list.ts:4, src/card.ts:9 read it"));
  assert.ok(section.includes(`GET ${ALL} carries it`));
  assert.match(pack.text ?? "", /It holds .*the data contradictions/);
});

test("the pack hands the facts to the grounding with how many pages had a shape to read", async () => {
  const pack = await buildContextPack({ ...input, consumerExpectations: EXPECTS_CATEGORY }, captureDeps([browse, home]));
  assert.equal(pack.dataContradictions?.read, 1);
  assert.deepEqual(pack.dataContradictions?.facts.map((f) => [f.route, f.key]), [["/browse", "category"]]);
});

test("a pack whose pages show no contradiction has no section, and still says the pages were read", async () => {
  const quiet: CapturedPage = { ...browse, shapes: { listed: [shape(ALL, 4, COMMON), shape(BY_REGION, 4, [...COMMON, "category"])], omitted: 0 } };
  const pack = await buildContextPack({ ...input, consumerExpectations: EXPECTS_CATEGORY }, captureDeps([quiet, home]));
  assert.doesNotMatch(pack.text ?? "", new RegExp(PACK_HEADINGS.contradictions));
  assert.equal(pack.dataContradictions?.read, 1);
  assert.deepEqual(pack.dataContradictions?.facts, []);
});

test("a pack whose pages read no JSON records nothing about contradictions, as before", async () => {
  const pack = await buildContextPack(input, captureDeps([{ ...browse, shapes: undefined }, home]));
  assert.equal(pack.dataContradictions, undefined);
  assert.match(pack.text ?? "", /route \/browse:\n {2}heading: Browse/);
});

test("the provider's response schema classifies a fact: it declares the field the answer lacks, or does not", async () => {
  const declares = (_method: string, url: string): ReadonlySet<string> | undefined => (url === BY_REGION ? new Set([...COMMON, "category"]) : undefined);
  const backed = await buildContextPack({ ...input, consumerExpectations: EXPECTS_CATEGORY, responseFields: declares }, captureDeps([browse, home]));
  assert.equal(backed.dataContradictions?.facts[0]?.provider, "provider-declared-absent");
  assert.match(sectionOf(backed.text), /schema declares it/);
  const silent = await buildContextPack({ ...input, consumerExpectations: EXPECTS_CATEGORY, responseFields: () => new Set(COMMON) }, captureDeps([browse, home]));
  assert.equal(silent.dataContradictions?.facts[0]?.provider, "provider-undeclared");
});

test("with no consumer expectation the pack finds no contradiction, whatever the answers of two sources look like", async () => {
  const pack = await buildContextPack(input, captureDeps([browse, home]));
  assert.doesNotMatch(pack.text ?? "", new RegExp(PACK_HEADINGS.contradictions));
  assert.deepEqual(pack.dataContradictions?.facts, []);
});

test("a page opened from a template of the map is named by both addresses", async () => {
  const page: CapturedPage = { ...browse, route: "/browse/es", template: "/browse/:region" };
  const pack = await buildContextPack({ ...input, routes: ["/browse/es"], consumerExpectations: EXPECTS_CATEGORY }, captureDeps([page, home], "route /browse/es (instance of /browse/:region):\n  heading: Browse"));
  assert.ok(sectionOf(pack.text).includes("- /browse/es (instance of /browse/:region): GET"));
});

test("a secret in an operation's address is taken out by the pattern redaction every pack text passes", async () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const leaky: CapturedPage = { ...browse, shapes: { listed: [shape(ALL, 40, [...COMMON, "category"]), shape(`https://app.example/api/${token}/items`, 12, COMMON)], omitted: 0 } };
  const leaksTheToken: ConsumerExpectationsOf = (request) => (request.path.includes(token) ? EXPECTS_CATEGORY({ ...request, path: "/api/items/by-region/ES" }) : undefined);
  const pack = await buildContextPack({ ...input, consumerExpectations: leaksTheToken }, captureDeps([leaky, home]));
  assert.equal((pack.text ?? "").includes(token), false);
  assert.ok(sectionOf(pack.text).includes(REDACTED));
});

test("a page the pack was only given for the links it shows is not read, and a pack with the DOM capture off records none", async () => {
  const seed: CapturedPage = { ...browse, route: "/", shapes: browse.shapes };
  const deps = captureDeps([home, seed]);
  const listed = await buildContextPack(input, deps);
  assert.equal(listed.dataContradictions, undefined);
  const off = await buildContextPack({ ...input, domPack: false }, captureDeps([browse, home]));
  assert.equal(off.dataContradictions, undefined);
});

test("an expectation source that throws costs the contradictions and nothing else: the pack is built, and the fault is logged", async () => {
  const logs: string[] = [];
  const deps: ContextPackDeps = { ...captureDeps([browse, home]), log: (message) => logs.push(message) };
  const throwing: ConsumerExpectationsOf = () => {
    throw new Error("the compiler fell over");
  };
  const pack = await buildContextPack({ ...input, consumerExpectations: throwing }, deps);
  assert.match(pack.text ?? "", /route \/browse:\n {2}heading: Browse/);
  assert.equal(pack.dataContradictions, undefined);
  assert.doesNotMatch(pack.text ?? "", new RegExp(PACK_HEADINGS.contradictions));
  assert.ok(logs.some((line) => /WARNING.*contradictions were not found.*the compiler fell over/.test(line)), logs.join("\n"));
});
