import { test } from "node:test";
import assert from "node:assert/strict";
import { packPagesFor } from "@contexts/generation/domain/pack-pages.ts";
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

test("the slice stops at whole pages within its bound and says how many it left out", () => {
  const big = [`### ${PACK_HEADINGS.liveDom}`, "route /a:", `  text "${"a".repeat(300)}"`, "route /b:", `  text "${"b".repeat(300)}"`].join("\n");
  const slice = packPagesFor(big, ["/a", "/b"], 400)!;
  assert.ok(slice.includes("aaa"));
  assert.ok(!slice.includes("bbb"));
  assert.match(slice, /1/);
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
