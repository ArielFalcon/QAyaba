/* The Context Pack lists, per captured page, the fields the consumer's code expects that its answers lack; a flow is handed those of its pages. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { packPagesFor } from "@contexts/generation/domain/pack-pages.ts";
import { CONTRADICTIONS_SECTION_INTRO, contradictionsSectionLines } from "@contexts/generation/domain/pack-contradictions.ts";
import { pagesDegrade } from "@contexts/generation/domain/window-fit-references.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";
import { contradictionFact } from "../../../support/data-contradiction.ts";

const fact = (route: string, key: string, extra: Partial<DataContradiction> = {}): DataContradiction => contradictionFact({ route, key, ...extra });

test("each fact names its page, the operation whose answers lack the field, where the consumer declares and reads it, and what the provider's contract says", () => {
  const lines = contradictionsSectionLines([fact("/browse", "category", { provider: "provider-declared-absent" }), fact("/shops/es", "zone", { template: "/shops/:region" })]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith("- /browse: GET https://app.example/api/items/by-region/ES returned 12 items, none carrying \"category\" at any depth"));
  assert.match(lines[0]!, /src\/api\.ts:12 declares Item\[\] for the answer, src\/list\.ts:4 reads it and nothing writes it/);
  assert.match(lines[0]!, /schema declares it \(provider-declared-absent\)/);
  assert.ok(lines[1]!.startsWith("- /shops/es (instance of /shops/:region): "));
  assert.match(lines[1]!, /schema does not declare it \(provider-undeclared\)/);
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
  assert.ok(slice.includes("none carrying \"category\""));
  assert.equal(slice.includes("none carrying \"total\""), false);
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
  assert.ok(someRequests.includes("none carrying \"category\""), "the contradiction is still shown");

  const noRequests = degrade(pages + requests)!.content;
  assert.match(noRequests, /\(2 more request\(s\)/);
  assert.ok(noRequests.includes("none carrying \"category\""), "the contradiction outlasts every request");

  const none = degrade(pages + requests + 1)!;
  assert.match(none.content, /\(1 more contradiction\(s\) are not shown here, to fit the window\)/);
  assert.equal(none.content.includes("none carrying \"category\""), false);
  assert.equal(degrade(pages + requests + 2), undefined);
});
