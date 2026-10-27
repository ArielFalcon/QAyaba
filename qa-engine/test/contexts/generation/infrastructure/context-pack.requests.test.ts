/* The pack says, as facts, which data requests each captured page made while it was captured; the Live DOM it already gave is unchanged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, PACK_HEADINGS, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { CapturedPage } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";

const STYLE = "https://maps.example/styles/v1/owner/theme-a";

function captureDeps(pages: CapturedPage[], report = "route /map:\n  heading: Map\nroute /home:\n  heading: Home"): ContextPackDeps {
  return {
    captureDomForRoutes: async (_routes, input) => {
      input.onPages?.(pages);
      return report;
    },
    domDeps: { render: async () => [] },
    log: () => {},
  };
}

const map: CapturedPage = { route: "/map", grounded: true, links: [], nodes: ["heading: Map"], requests: { listed: [{ method: "GET", url: STYLE, count: 1 }, { method: "GET", url: "https://dev.example/api/places", count: 2 }], omitted: 0 } };
const home: CapturedPage = { route: "/home", grounded: true, links: [], nodes: ["heading: Home"] };
const input = { baseUrl: "http://dev.example", e2eDir: "/tmp/e2e", routes: ["/map", "/home"] };

const sectionOf = (text: string | undefined): string => (text ?? "").split(/^### /m).find((part) => part.startsWith(PACK_HEADINGS.requests)) ?? "";

test("the pack lists each captured page's requests, one fact each, with the origin of every request and no query", async () => {
  const pack = await buildContextPack(input, captureDeps([map, home]));
  const section = sectionOf(pack.text);
  assert.ok(section.includes(`- /map: GET ${STYLE}\n`));
  assert.ok(section.includes("- /map: GET https://dev.example/api/places (×2)"));
  assert.equal(section.includes("/home"), false, "a page that made no request has no fact");
  assert.equal(section.includes("?"), false);
  assert.match(pack.text ?? "", /It holds .*the data requests the captured pages made/);
});

test("what the capture's safety bounds left out is a fact of the page", async () => {
  const pack = await buildContextPack(input, captureDeps([{ ...map, requests: { listed: map.requests!.listed, omitted: 12 } }, home]));
  assert.match(sectionOf(pack.text), /- \/map: \(\+12 more request\(s\) not kept/);
});

test("a page opened from a template of the map is named by both addresses", async () => {
  const page: CapturedPage = { ...map, route: "/shops/madrid", template: "/shops/:city" };
  const pack = await buildContextPack({ ...input, routes: ["/shops/madrid"] }, captureDeps([page, home], "route /shops/madrid (instance of /shops/:city):\n  heading: Shops"));
  assert.ok(sectionOf(pack.text).includes(`- /shops/madrid (instance of /shops/:city): GET ${STYLE}`));
});

test("a secret in a request's path is taken out by the pattern redaction every pack text passes", async () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const page: CapturedPage = { ...map, requests: { listed: [{ method: "GET", url: `https://api.example/v1/${token}/files`, count: 1 }], omitted: 0 } };
  const pack = await buildContextPack(input, captureDeps([page, home]));
  assert.equal((pack.text ?? "").includes(token), false);
  assert.ok(sectionOf(pack.text).includes(REDACTED));
});

test("a pack whose pages made no request has no requests section, as before", async () => {
  const pack = await buildContextPack(input, captureDeps([{ ...map, requests: undefined }, home]));
  assert.doesNotMatch(pack.text ?? "", new RegExp(PACK_HEADINGS.requests));
  assert.doesNotMatch(pack.text ?? "", /data requests/);
  assert.match(pack.text ?? "", /route \/map:\n {2}heading: Map/);
});

test("a page the pack was only given for the links it shows is not listed, and a pack with the DOM capture off lists none", async () => {
  const seed: CapturedPage = { route: "/", grounded: true, links: [], nodes: ["heading: Root"], requests: { listed: [{ method: "GET", url: "https://dev.example/api/boot", count: 1 }], omitted: 0 } };
  const deps = captureDeps([map, home, seed]);
  const listed = await buildContextPack(input, deps);
  assert.equal(sectionOf(listed.text).includes("/api/boot"), false);
  const off = await buildContextPack({ ...input, domPack: false }, deps);
  assert.doesNotMatch(off.text ?? "", new RegExp(PACK_HEADINGS.requests));
});
