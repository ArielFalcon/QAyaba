import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStubbedState, type StubbedStateReport } from "@contexts/test-execution/domain/stubbed-state.ts";

const IMPORTS = `import { test, expect } from "./fixtures";\n`;

const detect = (text: string, file = "flow.spec.ts"): StubbedStateReport => detectStubbedState([{ file, text }]);

const kinds = (report: StubbedStateReport): string[] => report.violations.map((v) => v.kind);

const LIVE_TEST = `test("lists the cuisines", async ({ page }) => {
  await page.goto("/restaurants");
  await expect(page.getByRole("list")).toBeVisible();
});
`;

test("a test that fulfils a GET response is stubbed, and one that does not is live", () => {
  const report = detect(`${IMPORTS}
${LIVE_TEST}
test("[stubbed: geo response without the cuisine field] disables every chip", async ({ page }) => {
  await page.route("**/geo/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { items: [] } });
  });
  await page.goto("/restaurants");
  await expect(page.getByRole("button", { name: "Pizza" })).toBeDisabled();
});
`);
  assert.deepEqual(report.tests.map((t) => t.name), ["[stubbed: geo response without the cuisine field] disables every chip"]);
  assert.equal(report.tests[0]!.file, "flow.spec.ts");
  assert.equal(report.tests[0]!.response, "geo response without the cuisine field");
  assert.deepEqual(report.tests[0]!.routes, ["**/geo/**"]);
  assert.deepEqual(report.violations, []);
});

test("a spec with no route interception reports nothing", () => {
  const report = detect(`${IMPORTS}${LIVE_TEST}`);
  assert.deepEqual(report.tests, []);
  assert.deepEqual(report.violations, []);
});

test("a hook that fulfils a route makes every test under it stubbed, and a sibling describe stays live", () => {
  const report = detect(`${IMPORTS}
test.describe("with a stated response", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/geo", (route) => (route.request().method() === "GET" ? route.fulfill({ json: {} }) : route.continue()));
  });
  test("first", async ({ page }) => { await page.goto("/"); await expect(page).toHaveURL("/"); });
  test("second", async ({ page }) => { await page.goto("/"); await expect(page).toHaveURL("/"); });
});
test.describe("live", () => {
  test("third", async ({ page }) => { await page.goto("/"); await expect(page).toHaveURL("/"); });
});
`);
  assert.deepEqual(report.tests.map((t) => t.name), ["first", "second"]);
});

test("a context-level route and a local helper that routes both make the calling test stubbed", () => {
  const report = detect(`${IMPORTS}
async function stubGeo(page: import("@playwright/test").Page) {
  await page.route("**/geo", (route) => (route.request().method() === "GET" ? route.fulfill({ json: {} }) : route.continue()));
}
test("through a helper", async ({ page }) => { await stubGeo(page); await expect(page).toHaveURL("/"); });
test("through the context", async ({ context, page }) => {
  await context.route("**/geo", (route) => (route.request().method() === "GET" ? route.fulfill({ json: {} }) : route.continue()));
  await expect(page).toHaveURL("/");
});
`);
  assert.deepEqual(report.tests.map((t) => t.name), ["through a helper", "through the context"]);
});

test("a call to a helper imported from another module is ambiguous and reported as stubbed, never as live", () => {
  const report = detect(`${IMPORTS}import { stubGeo } from "./support/stubs";
test("through an imported helper", async ({ page }) => { await stubGeo(page); await expect(page).toHaveURL("/"); });
test("through the fixtures", async ({ page }) => { await expect(page).toHaveURL("/"); });
`);
  assert.deepEqual(report.tests.map((t) => t.name), ["through an imported helper"]);
});

test("a fulfil that no GET check guards is a violation, and the accepted guards are not", () => {
  const unguarded = detect(`${IMPORTS}${LIVE_TEST}
test("unguarded", async ({ page }) => {
  await page.route("**/orders", (route) => route.fulfill({ status: 201, json: { id: 1 } }));
  await expect(page).toHaveURL("/");
});
`);
  assert.deepEqual(kinds(unguarded), ["fulfil-without-get-guard"]);
  assert.equal(unguarded.violations[0]!.test, "unguarded");

  const guards = [
    `async (route) => { if (route.request().method() === "GET") { await route.fulfill({ json: {} }); } else { await route.continue(); } }`,
    `async (route) => { const method = route.request().method(); if (method !== "GET") { await route.continue(); return; } await route.fulfill({ json: {} }); }`,
    `(route) => route.request().method() === "GET" ? route.fulfill({ json: {} }) : route.fallback()`,
    `async (route) => { route.request().method() === "GET" && (await route.fulfill({ json: {} })); }`,
  ];
  for (const handler of guards) {
    const report = detect(`${IMPORTS}${LIVE_TEST}test("guarded", async ({ page }) => { await page.route("**/x", ${handler}); await expect(page).toHaveURL("/"); });\n`);
    assert.deepEqual(report.violations, [], handler);
    assert.equal(report.tests.length, 1, handler);
  }
});

test("a handler the detector cannot read is a violation and its test is stubbed", () => {
  const report = detect(`${IMPORTS}import { handler } from "./support/handler";
${LIVE_TEST}
test("opaque", async ({ page }) => { await page.route("**/x", handler); await expect(page).toHaveURL("/"); });
`);
  assert.deepEqual(report.tests.map((t) => t.name), ["opaque"]);
  assert.deepEqual(kinds(report), ["unverifiable-handler"]);
});

test("a continue or fallback that changes the request method or body is a violation even behind a GET check", () => {
  const report = detect(`${IMPORTS}${LIVE_TEST}
test("rewrites", async ({ page }) => {
  await page.route("**/x", async (route) => {
    if (route.request().method() === "GET") return route.continue({ method: "POST", postData: "{}" });
    await route.continue();
  });
  await expect(page).toHaveURL("/");
});
`);
  assert.deepEqual(kinds(report), ["override-changes-request"]);
});

test("a continue that changes nothing about the method or body is not a violation", () => {
  const report = detect(`${IMPORTS}${LIVE_TEST}
test("adds a header on a read", async ({ page }) => {
  await page.route("**/x", async (route) => {
    if (route.request().method() === "GET") return route.continue({ headers: { ...route.request().headers(), "x-probe": "1" } });
    await route.continue();
  });
  await expect(page).toHaveURL("/");
});
`);
  assert.deepEqual(report.violations, []);
});

test("a HAR replay is stubbed and a violation, because it answers every method", () => {
  const report = detect(`${IMPORTS}${LIVE_TEST}
test("replays", async ({ page }) => { await page.routeFromHAR("fixtures/geo.har"); await expect(page).toHaveURL("/"); });
`);
  assert.deepEqual(report.tests.map((t) => t.name), ["replays"]);
  assert.deepEqual(kinds(report), ["har-replay"]);
});

test("a spec file whose every test is stubbed has no live test beside them", () => {
  const stub = `test.beforeEach(async ({ page }) => { await page.route("**/g", (r) => (r.request().method() === "GET" ? r.fulfill({ json: {} }) : r.continue())); });\n`;
  const alone = detect(`${IMPORTS}${stub}test("only", async ({ page }) => { await expect(page).toHaveURL("/"); });\n`);
  assert.deepEqual(kinds(alone), ["no-live-test"]);
  assert.equal(alone.violations[0]!.file, "flow.spec.ts");

  const beside = detect(`${IMPORTS}${LIVE_TEST}test.describe("stated", () => { ${stub} test("one", async ({ page }) => { await expect(page).toHaveURL("/"); }); });\n`);
  assert.deepEqual(beside.violations, []);
});

test("a route registration in a comment or a string is not an interception", () => {
  const report = detect(`${IMPORTS}
// await page.route("**/x", (route) => route.fulfill({}));
test("mentions it", async ({ page }) => {
  const note = "page.route(url, route.fulfill)";
  await expect(page).toHaveURL("/");
  expect(note).toBeTruthy();
});
`);
  assert.deepEqual(report.tests, []);
  assert.deepEqual(report.violations, []);
});

test("the report counts the spec files that hold a stubbed test, across files", () => {
  const stubbed = `${IMPORTS}${LIVE_TEST}test("s", async ({ page }) => { await page.route("**/g", (r) => (r.request().method() === "GET" ? r.fulfill({ json: {} }) : r.continue())); await expect(page).toHaveURL("/"); });\n`;
  const report = detectStubbedState([
    { file: "a.spec.ts", text: stubbed },
    { file: "b.spec.ts", text: `${IMPORTS}${LIVE_TEST}` },
    { file: "c.spec.ts", text: stubbed },
  ]);
  assert.equal(report.specFiles, 2);
  assert.equal(report.tests.length, 2);
});

test("a file that does not parse contributes nothing", () => {
  const report = detect(`${IMPORTS}test("broken", async ({ page }) => { await page.route( });`);
  assert.deepEqual(report.tests, []);
  assert.deepEqual(report.violations, []);
});

test("a stubbed test names the fields the response it fulfils carries, at every depth, when the spec states the body: a literal, a stringified literal, a constant of the file", () => {
  const report = detect(`${IMPORTS}
const BODY = { type: "Collection", entries: [{ detail: { label: "private-value" } }] };
test("[stubbed: literal] a", async ({ page }) => {
  await page.route("**/a/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { items: [{ id: 1, properties: { zone: "x" } }], total: 1 } });
  });
});
test("[stubbed: stringified] b", async ({ page }) => {
  await page.route("**/b/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ rows: [{ cell: 1 }] }) });
  });
});
test("[stubbed: constant] c", async ({ page }) => {
  await page.route("**/c/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: BODY });
  });
});
`);
  const fulfils = (name: string): string[] | undefined => report.tests.find((t) => t.name.includes(name))?.fulfils;
  assert.deepEqual(fulfils("literal"), ["id", "items", "properties", "total", "zone"]);
  assert.deepEqual(fulfils("stringified"), ["cell", "rows"]);
  assert.deepEqual(fulfils("constant"), ["detail", "entries", "label", "type"]);
  assert.equal(JSON.stringify(report).includes("private-value"), false);
});

test("a stubbed test whose fulfilled body the spec does not state names no field, and a live test none", () => {
  const report = detect(`${IMPORTS}${LIVE_TEST}
import { body } from "./payloads";
test("[stubbed: imported] d", async ({ page }) => {
  await page.route("**/d/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: body });
  });
});
`);
  assert.equal(report.tests.length, 1);
  assert.equal(report.tests[0]!.fulfils, undefined);
});
