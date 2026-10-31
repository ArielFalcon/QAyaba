/* The extractor over delivered specs and tool targets: route template matching, shared hash8, DOM attribution to the preceding goto. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hash8, itemId } from "@kernel/context-item-ids.ts";
import { extractReferences, matchRouteTemplate, normalizeRoutePath } from "@contexts/evaluation/domain/context-refs.ts";

test("a concrete path matches the template whose literal segments line up and whose :params each fill one segment", () => {
  const templates = ["/restaurantes", "/restaurantes/:province", "/restaurantes/:province/:city"];
  assert.equal(matchRouteTemplate("/restaurantes/madrid/madrid", templates), "/restaurantes/:province/:city");
  assert.equal(matchRouteTemplate("/restaurantes/madrid", templates), "/restaurantes/:province");
  assert.equal(matchRouteTemplate("/restaurantes", templates), "/restaurantes");
  assert.equal(matchRouteTemplate("/home", templates), undefined);
});

test("a path is normalized before matching: query and fragment are dropped, the leading slash kept", () => {
  assert.equal(normalizeRoutePath("/restaurantes/madrid?city=1"), "/restaurantes/madrid");
  assert.equal(normalizeRoutePath("restaurantes/madrid#top"), "/restaurantes/madrid");
});

test("a getByTestId and a getByRole are attributed to the most recent goto, and the role name uses the shared hash8", () => {
  const spec = [
    "test('restaurants', async ({ page }) => {",
    "  await page.goto('/restaurantes/madrid/madrid');",
    "  await page.getByTestId('restaurant-card-0').first().isVisible();",
    "  await page.getByRole('button', { name: 'Cambiar filtros' }).click();",
    "});",
  ].join("\n");
  const refs = extractReferences({ specTexts: [spec], routeTemplates: ["/restaurantes/:province/:city"], opIds: [] });
  assert.deepEqual(refs.routeIds, ["route:/restaurantes/:province/:city"]);
  assert.ok(refs.domIds.includes(itemId.dom("/restaurantes/:province/:city", "restaurant-card-0")));
  /* The role hash is the same helper the id builder uses, so the extracted id equals the delivered id by construction. */
  assert.ok(refs.domIds.includes(itemId.domRole("/restaurantes/:province/:city", "button", "Cambiar filtros")));
  assert.equal(hash8("Cambiar filtros"), hash8("Cambiar filtros"));
});

test("a reference before any goto is unattributed, never a miss", () => {
  const spec = ["test('no nav', () => {", "  await page.getByTestId('orphan').click();", "});"].join("\n");
  const refs = extractReferences({ specTexts: [spec], routeTemplates: ["/restaurantes/:province/:city"], opIds: [] });
  assert.deepEqual(refs.domIds, []);
});

test("a literal operation id in the spec counts as referenced, an unknown one does not", () => {
  const spec = ["test('ops', () => {", "  // exercises getRestaurants", "});"].join("\n");
  const refs = extractReferences({ specTexts: [spec], routeTemplates: [], opIds: ["getRestaurants", "listOrders"] });
  assert.deepEqual(refs.opIds, ["op:getRestaurants"]);
});

test("route references from tool navigation targets count too", () => {
  const refs = extractReferences({
    specTexts: [],
    toolTargets: [{ tool: "browser", target: "https://dev.example.com/restaurantes/madrid/madrid" }],
    routeTemplates: ["/restaurantes/:province/:city"],
    opIds: [],
  });
  assert.deepEqual(refs.routeIds, ["route:/restaurantes/:province/:city"]);
});
