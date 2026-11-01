import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInterceptedTests } from "@contexts/test-execution/domain/intercepted-tests.ts";

const IMPORTS = `import { test, expect } from "./fixtures";\n`;

const detect = (text: string, file = "flow.spec.ts") => detectInterceptedTests([{ file, text }]);

const LIVE_TEST = `test("lists the cuisines", async ({ page }) => {
  await page.goto("/restaurants");
  await expect(page.getByRole("list")).toBeVisible();
});
`;

test("a test that fulfils a route is intercepting, named by its title path, and one that does not is live", () => {
  const found = detect(`${IMPORTS}
${LIVE_TEST}
test.describe("geo", () => {
  test("disables every chip", async ({ page }) => {
    await page.route("**/geo/**", async (route) => {
      await route.fulfill({ json: { items: [] } });
    });
    await page.goto("/restaurants");
    await expect(page.getByRole("button", { name: "Pizza" })).toBeDisabled();
  });
});
`);
  assert.deepEqual(found, [{ file: "flow.spec.ts", name: "geo › disables every chip" }]);
});

test("a spec with no request interception reports nothing", () => {
  assert.deepEqual(detect(`${IMPORTS}${LIVE_TEST}`), []);
});

test("a hook that intercepts makes every test under it intercepting, and a sibling describe stays live", () => {
  const found = detect(`${IMPORTS}
test.describe("with a stub", () => {
  test.beforeEach(async ({ page }) => { await page.route("**/geo/**", (route) => route.fulfill({ status: 200, body: "[]" })); });
  test("first", async ({ page }) => { await page.goto("/"); await expect(page).toHaveURL("/"); });
  test("second", async ({ page }) => { await page.goto("/"); await expect(page).toHaveURL("/"); });
});
test.describe("without", () => {
  test("third", async ({ page }) => { await page.goto("/"); await expect(page).toHaveURL("/"); });
});
`);
  assert.deepEqual(found.map((t) => t.name), ["with a stub › first", "with a stub › second"]);
});

test("a context-level route, a local helper that routes and a HAR replay all make the calling test intercepting", () => {
  const found = detect(`${IMPORTS}
async function stubGeo(page) { await page.route("**/geo/**", (route) => route.abort()); }
test("through a helper", async ({ page }) => { await stubGeo(page); await expect(page).toHaveURL("/"); });
test("through the context", async ({ context, page }) => {
  await context.route("**/geo/**", (route) => route.fulfill({ json: [] }));
  await expect(page).toHaveURL("/");
});
test("by replay", async ({ page }) => { await page.routeFromHAR("fixtures/geo.har"); await expect(page).toHaveURL("/"); });
test("with a fake socket", async ({ page }) => { await page.routeWebSocket("**/ws", () => {}); await expect(page).toHaveURL("/"); });
test("by replacing fetch", async ({ page }) => { await page.addInitScript(() => { window.fetch = async () => new Response("[]"); }); await expect(page).toHaveURL("/"); });
`);
  assert.deepEqual(found.map((t) => t.name), ["through a helper", "through the context", "by replay", "with a fake socket", "by replacing fetch"]);
});

test("a call to a helper from another module is not read as an interception: the author cannot have written it", () => {
  const found = detect(`${IMPORTS}import { loginAs } from "./support/login";
test("through an imported helper", async ({ page }) => { await loginAs(page); await expect(page).toHaveURL("/"); });
`);
  assert.deepEqual(found, []);
});

test("a route registration in a comment or a string is not an interception", () => {
  const found = detect(`${IMPORTS}
test("mentions it", async ({ page }) => {
  // await page.route("**/geo/**", (route) => route.fulfill({ json: [] }));
  const note = "page.route('**/geo/**', handler)";
  await expect(page).toHaveURL("/");
});
`);
  assert.deepEqual(found, []);
});

test("the tests are read per file, and a file that does not parse contributes nothing", () => {
  const found = detectInterceptedTests([
    { file: "a.spec.ts", text: `${IMPORTS}test("a", async ({ page }) => { await page.route("**/x", (r) => r.fulfill({ json: 1 })); });` },
    { file: "b.spec.ts", text: `${IMPORTS}test("b", async ({ page }) => { await page.route("**/x", (r) => r.fulfill({ json: 1 }));` },
    { file: "c.spec.ts", text: `${IMPORTS}${LIVE_TEST}` },
  ]);
  assert.deepEqual(found, [{ file: "a.spec.ts", name: "a" }]);
});
