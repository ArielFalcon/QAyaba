/* The Context Pack lists, per captured page, the data requests it made; a flow is handed those of its pages, and the plan's facts can read what a page recorded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { packPagesFor, recordedRequestsFor } from "@contexts/generation/domain/pack-pages.ts";
import { REQUESTS_SECTION_INTRO, requestsSectionLines } from "@contexts/generation/domain/pack-requests.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";

const STYLE = "https://maps.example/styles/v1/owner/theme-a";

const lines = requestsSectionLines([
  { route: "/map", requests: { listed: [{ method: "GET", url: STYLE, count: 1 }, { method: "POST", url: "https://dev.example/api/orders", count: 3, blocked: true }], omitted: 0 } },
  { route: "/shops/madrid", template: "/shops/:city", requests: { listed: [{ method: "GET", url: "https://dev.example/api/shops", count: 2 }], omitted: 4 } },
  { route: "/quiet", requests: { listed: [], omitted: 0 } },
]);

test("each page's requests are listed one fact per request, with the count and whether it completed", () => {
  assert.ok(lines.includes(`- /map: GET ${STYLE}`));
  assert.ok(lines.includes("- /map: POST https://dev.example/api/orders (×3) [did not complete]"));
  assert.ok(lines.includes("- /shops/madrid (instance of /shops/:city): GET https://dev.example/api/shops (×2)"));
});

test("what the capture's bounds left out is stated for the page, and a page that made no request has no line", () => {
  assert.ok(lines.some((line) => line.startsWith("- /shops/madrid (instance of /shops/:city): (+4 more request(s)")));
  assert.equal(lines.some((line) => line.includes("/quiet")), false);
});

test("no page that made a request, no fact", () => {
  assert.deepEqual(requestsSectionLines([{ route: "/quiet", requests: { listed: [], omitted: 0 } }]), []);
  assert.deepEqual(requestsSectionLines([]), []);
});

const pack = [
  `## ${PACK_HEADINGS.pack}`,
  `### ${PACK_HEADINGS.liveDom} (a11y tree)`,
  "route /map:",
  "  heading \"Map\"",
  "route /shops/madrid (instance of /shops/:city):",
  "  heading \"Shops\"",
  "route /cart:",
  "  button \"Checkout\"",
  "",
  `### ${PACK_HEADINGS.requests} ${REQUESTS_SECTION_INTRO}`,
  ...lines,
  "",
  `### ${PACK_HEADINGS.contracts}`,
  "- `getCart`: GET /api/cart",
].join("\n");

test("a flow's pages come with the requests those pages made and no other page's", () => {
  const slice = packPagesFor(pack, ["/map"])!;
  assert.ok(slice.includes(`### ${PACK_HEADINGS.requests}`));
  assert.ok(slice.includes(`- /map: GET ${STYLE}`));
  assert.equal(slice.includes("/shops/madrid"), false);
  assert.equal(slice.includes("getCart"), false);
});

test("a page opened from a template of the map brings its requests to a flow that names the template", () => {
  const slice = packPagesFor(pack, ["/shops/:city"])!;
  assert.ok(slice.includes("- /shops/madrid (instance of /shops/:city): GET https://dev.example/api/shops (×2)"));
  assert.equal(slice.includes(STYLE), false);
});

test("a flow whose pages recorded no request gets its pages as before, with no requests section", () => {
  const slice = packPagesFor(pack, ["/cart"])!;
  assert.ok(slice.includes("button \"Checkout\""));
  assert.equal(slice.includes(PACK_HEADINGS.requests), false);
});

test("the requests a pack recorded for pages are read back, by address or by template, and nothing is read from a pack without the section", () => {
  assert.deepEqual(recordedRequestsFor(pack, ["/map"]), [`GET ${STYLE}`, "POST https://dev.example/api/orders (×3) [did not complete]"]);
  assert.deepEqual(recordedRequestsFor(pack, ["/shops/:city"]), ["GET https://dev.example/api/shops (×2)"]);
  assert.deepEqual(recordedRequestsFor(pack, ["/cart", "/nowhere"]), []);
  assert.deepEqual(recordedRequestsFor(undefined, ["/map"]), []);
  assert.deepEqual(recordedRequestsFor(`### ${PACK_HEADINGS.liveDom}\nroute /map:\n  heading "Map"`, ["/map"]), []);
});
