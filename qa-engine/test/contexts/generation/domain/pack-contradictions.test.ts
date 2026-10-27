/* The Context Pack lists, per captured page, the data contradictions its sources show; a flow is handed those of its pages. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { packPagesFor } from "@contexts/generation/domain/pack-pages.ts";
import { CONTRADICTIONS_SECTION_INTRO, contradictionsSectionLines } from "@contexts/generation/domain/pack-contradictions.ts";
import { pagesDegrade } from "@contexts/generation/domain/window-fit-references.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";

const fact = (route: string, key: string, extra: Partial<DataContradiction> = {}): DataContradiction => ({
  route,
  key,
  carriedBy: { operation: "GET https://app.example/api/items", items: 40 },
  missingFrom: { operation: "GET https://app.example/api/items/by-region/ES", items: 12 },
  schemaBacked: false,
  ...extra,
});

test("each fact names its page, the source that lacks the key and the one that carries it, and whether the app's schema backs it", () => {
  const lines = contradictionsSectionLines([fact("/browse", "category", { schemaBacked: true }), fact("/shops/es", "zone", { template: "/shops/:region" })]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith("- /browse: GET https://app.example/api/items/by-region/ES returned 12 items, none with \"category\""));
  assert.match(lines[0]!, /OpenAPI response schema/);
  assert.ok(lines[1]!.startsWith("- /shops/es (instance of /shops/:region): "));
  assert.doesNotMatch(lines[1]!, /OpenAPI response schema/);
});

test("no contradiction, no line", () => {
  assert.deepEqual(contradictionsSectionLines([]), []);
});

const page = (route: string, count: number): string[] => [`route ${route}:`, ...Array.from({ length: count }, (_, i) => `  button: ${route.slice(1)} action ${i}`)];
const pack = [
  `### ${PACK_HEADINGS.liveDom} (a11y tree)`,
  ...page("/browse", 5),
  ...page("/cart", 5),
  "",
  `### ${PACK_HEADINGS.contradictions} ${CONTRADICTIONS_SECTION_INTRO}`,
  ...contradictionsSectionLines([fact("/browse", "category"), fact("/cart", "total")]),
].join("\n");

test("a flow's pages come with the contradictions of those pages and no other page's", () => {
  const slice = packPagesFor(pack, ["/browse"])!;
  assert.ok(slice.includes(`### ${PACK_HEADINGS.contradictions}`));
  assert.ok(slice.includes("none with \"category\""));
  assert.equal(slice.includes("none with \"total\""), false);
});

test("a flow whose pages show no contradiction gets its pages with no such section", () => {
  assert.equal(packPagesFor(pack, ["/elsewhere"]), undefined);
  const quiet = packPagesFor(pack.replace(/- \/cart: .*/, ""), ["/cart"])!;
  assert.equal(quiet.includes(PACK_HEADINGS.contradictions), false);
});

test("over the window, a flow's pages give way first, then its requests, and its contradictions last, each as a count", () => {
  const withRequests = [
    pack,
    "",
    `### ${PACK_HEADINGS.requests} (data requests)`,
    "- /browse: GET https://app.example/api/a",
    "- /browse: GET https://app.example/api/b",
  ].join("\n");
  const dom = packPagesFor(withRequests, ["/browse"])!;
  const degrade = pagesDegrade({ dom, wrap: (text) => text });
  const pages = 1;
  const requests = 2;

  const someRequests = degrade(pages + 1)!.content;
  assert.match(someRequests, /\(1 more request\(s\) are not shown here, to fit the window\)/);
  assert.ok(someRequests.includes("none with \"category\""), "the contradiction is still shown");

  const noRequests = degrade(pages + requests)!.content;
  assert.match(noRequests, /\(2 more request\(s\)/);
  assert.ok(noRequests.includes("none with \"category\""), "the contradiction outlasts every request");

  const none = degrade(pages + requests + 1)!;
  assert.match(none.content, /\(1 more contradiction\(s\) are not shown here, to fit the window\)/);
  assert.equal(none.content.includes("none with \"category\""), false);
  assert.equal(degrade(pages + requests + 2), undefined);
});
