/* The pack says, as facts of the page, which data sources of it disagree on what their items carry; what the pack gave before is unchanged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, PACK_HEADINGS, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { CapturedPage } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { DataShape } from "@contexts/generation/domain/route-snapshot.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";

const ALL = "https://app.example/api/items";
const BY_REGION = "https://app.example/api/items/by-region/ES";
const COMMON = ["address", "id", "name", "price", "region"];
const shape = (url: string, items: number, keys: string[]): DataShape => ({ method: "GET", url, items, keys, complete: true });

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

test("the pack states, per page, a key one data source's items carry and a source of the same kind carries in none", async () => {
  const pack = await buildContextPack(input, captureDeps([browse, home]));
  const section = sectionOf(pack.text);
  assert.ok(section.includes(`- /browse: GET ${BY_REGION} returned 12 items, none with "category"`));
  assert.ok(section.includes(`GET ${ALL} returned 40 items of the same kind with it`));
  assert.match(pack.text ?? "", /It holds .*the data contradictions/);
});

test("the pack hands the facts to the grounding with how many pages had a shape to read", async () => {
  const pack = await buildContextPack(input, captureDeps([browse, home]));
  assert.equal(pack.dataContradictions?.read, 1);
  assert.deepEqual(pack.dataContradictions?.facts.map((f) => [f.route, f.key]), [["/browse", "category"]]);
});

test("a pack whose pages show no contradiction has no section, and still says the pages were read", async () => {
  const quiet: CapturedPage = { ...browse, shapes: { listed: [shape(ALL, 4, COMMON), shape(BY_REGION, 4, COMMON)], omitted: 0 } };
  const pack = await buildContextPack(input, captureDeps([quiet, home]));
  assert.doesNotMatch(pack.text ?? "", new RegExp(PACK_HEADINGS.contradictions));
  assert.equal(pack.dataContradictions?.read, 1);
  assert.deepEqual(pack.dataContradictions?.facts, []);
});

test("a pack whose pages read no JSON records nothing about contradictions, as before", async () => {
  const pack = await buildContextPack(input, captureDeps([{ ...browse, shapes: undefined }, home]));
  assert.equal(pack.dataContradictions, undefined);
  assert.match(pack.text ?? "", /route \/browse:\n {2}heading: Browse/);
});

test("the app's response schema backs a fact when it declares the key the source lacks", async () => {
  const fieldsOf = (_method: string, url: string): ReadonlySet<string> | undefined => (url === BY_REGION ? new Set([...COMMON, "category"]) : undefined);
  const pack = await buildContextPack({ ...input, responseFields: fieldsOf }, captureDeps([browse, home]));
  assert.equal(pack.dataContradictions?.facts[0]?.schemaBacked, true);
  assert.match(sectionOf(pack.text), /OpenAPI response schema/);
});

test("a page opened from a template of the map is named by both addresses", async () => {
  const page: CapturedPage = { ...browse, route: "/browse/es", template: "/browse/:region" };
  const pack = await buildContextPack({ ...input, routes: ["/browse/es"] }, captureDeps([page, home], "route /browse/es (instance of /browse/:region):\n  heading: Browse"));
  assert.ok(sectionOf(pack.text).includes("- /browse/es (instance of /browse/:region): GET"));
});

test("a secret in an operation's address is taken out by the pattern redaction every pack text passes", async () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const leaky: CapturedPage = { ...browse, shapes: { listed: [shape(ALL, 40, [...COMMON, "category"]), shape(`https://app.example/api/${token}/items`, 12, COMMON)], omitted: 0 } };
  const pack = await buildContextPack(input, captureDeps([leaky, home]));
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
