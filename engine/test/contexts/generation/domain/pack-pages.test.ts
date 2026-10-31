import { test } from "node:test";
import assert from "node:assert/strict";
import { domPageCount, packPagesFor, referenceDomPages } from "@contexts/generation/domain/pack-pages.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";

const pack = [
  `## ${PACK_HEADINGS.pack}`,
  `### ${PACK_HEADINGS.changedValues}`,
  "- src/app/cart.ts",
  `### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`,
  "These roles + accessible names are what the browser ACTUALLY exposes.",
  "route /cart:",
  "  button \"Checkout\"",
  "route /shops/madrid/centro (instance of /shops/:province/:city):",
  "  heading \"Shops in Centro\"",
  "route /account: (redirected to /login)",
  `### ${PACK_HEADINGS.contracts}`,
  "- `getCart`: GET /api/cart",
].join("\n");

test("a flow is given the Live DOM of the pages it visits, by address or by the template a page was opened from, with the section's own head", () => {
  const slice = packPagesFor(pack, ["/cart", "/shops/:province/:city"])!;
  assert.ok(slice.includes(PACK_HEADINGS.liveDom));
  assert.ok(slice.includes("These roles + accessible names"));
  assert.ok(slice.includes("button \"Checkout\""));
  assert.ok(slice.includes("heading \"Shops in Centro\""));
  assert.ok(!slice.includes("/account"));
  assert.ok(!slice.includes(PACK_HEADINGS.changedValues));
  assert.ok(!slice.includes("getCart"));
});

test("a trailing slash does not hide a page, and a flow whose pages the pack did not read gets nothing", () => {
  assert.ok(packPagesFor(pack, ["/cart/"])?.includes("Checkout"));
  assert.equal(packPagesFor(pack, ["/nowhere"]), undefined);
  assert.equal(packPagesFor(undefined, ["/cart"]), undefined);
  assert.equal(packPagesFor(`### ${PACK_HEADINGS.changedValues}\n- x`, ["/cart"]), undefined);
});

test("a flow's pages reach it whole whatever their size: no fixed bound cuts them, the window decides", () => {
  const page = (route: string, letter: string): string[] => [`route ${route}:`, ...Array.from({ length: 200 }, (_, i) => `  text "${letter.repeat(60)} ${i}"`)];
  const big = [`### ${PACK_HEADINGS.liveDom}`, ...page("/a", "a"), ...page("/b", "b")].join("\n");
  const slice = packPagesFor(big, ["/a", "/b"])!;
  assert.ok(slice.length > 12_000);
  assert.ok(slice.includes(`text "${"a".repeat(60)} 199"`));
  assert.ok(slice.includes(`text "${"b".repeat(60)} 199"`));
  assert.doesNotMatch(slice, /left out/);
});

test("pages give way to references the last page first, each naming its page and how many lines it held", () => {
  const dom = ["route /a:", "  button: A", "  link: A2", "route /shops/madrid (instance of /shops/:city):", "  heading: Shops", "(trailer)"].join("\n");
  assert.equal(domPageCount(dom), 2);
  const one = referenceDomPages(dom, 1);
  assert.match(one.text, /route \/a:\n {2}button: A\n {2}link: A2/);
  assert.match(one.text, /route \/shops\/madrid \(instance of \/shops\/:city\):\n {2}\(this page's 1 line\(s\) are not shown here, to fit the window\)/);
  assert.ok(one.text.endsWith("(trailer)"));
  assert.deepEqual(one.left, [{ route: "/shops/:city", lines: 1 }]);
  const both = referenceDomPages(dom, 2);
  assert.deepEqual(both.left.map((p) => p.route), ["/a", "/shops/:city"]);
  assert.doesNotMatch(both.text, /button: A/);
});

test("in a pack only the Live DOM section's pages give way: the other sections stay as they are", () => {
  const out = referenceDomPages(pack, 3, { section: PACK_HEADINGS.liveDom });
  assert.match(out.text, /getCart/);
  assert.match(out.text, /src\/app\/cart\.ts/);
  assert.doesNotMatch(out.text, /Checkout/);
  assert.deepEqual(out.left.map((p) => p.route), ["/cart", "/shops/:province/:city"], "a page with no lines of its own has nothing to leave out");
});

test("a page listed under its template's own address is read whole, not cut at the template's first parameter", () => {
  const listed = [`### ${PACK_HEADINGS.liveDom}`, "route /shops/:province/:city: (could not capture — no link)", "route /shops/:province:", "  text \"other\""].join("\n");
  const slice = packPagesFor(listed, ["/shops/:province/:city"])!;
  assert.ok(slice.includes("could not capture"));
  assert.ok(!slice.includes("other"));
});

test("a flow that names a page with a query is given that page, and a heading of any level ends the Live DOM section", () => {
  const withTrailer = [pack.replace(`### ${PACK_HEADINGS.contracts}\n- \`getCart\`: GET /api/cart`, ""), "## Another section", "- not a page line"].join("\n");
  const slice = packPagesFor(withTrailer, ["/cart?coupon=x"])!;
  assert.ok(slice.includes("button \"Checkout\""));
  assert.ok(!slice.includes("Another section"));
  assert.ok(!slice.includes("not a page line"));
});

test("a flow that names a page of a template with a stand-in value is given the pages the pack opened for that template", () => {
  assert.ok(packPagesFor(pack, ["/shops/madrid/:city"])?.includes("Shops in Centro"));
  assert.ok(packPagesFor(pack, ["/shops/barcelona/gracia"])?.includes("Shops in Centro"), "another page of the same template");
  assert.equal(packPagesFor(pack, ["/shops/madrid"]), undefined);
});
