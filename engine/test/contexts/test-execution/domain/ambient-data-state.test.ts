import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAmbientDataPins } from "@contexts/test-execution/domain/ambient-data-state.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const IMPORTS = `import { test, expect } from "../fixtures";\n`;
const FILE = "flows/listing.spec.ts";
const EMPTY_PAGE = "/listing";

/* A passing case as the report names it: the file's own title first, then the title path. */
const passed = (titlePath: string, file = FILE): QaCase => ({ name: `${file} › ${titlePath}`, status: "pass", file });

const pinsOf = (text: string, cases: QaCase[], emptyPages: string[] = [EMPTY_PAGE]) =>
  detectAmbientDataPins({ specs: [{ file: FILE, text }], cases, emptyPages });

test("a passing case that only asserts a page DEV served confirmed empty, as it loaded, is an ambient pin naming that page", () => {
  const pins = pinsOf(`${IMPORTS}
test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  const empty = page.getByText("Nothing here yet");
  await expect(empty).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(0);
});
`, [passed("renders the empty listing")]);
  assert.equal(pins.length, 1);
  const [pin] = pins;
  assert.equal(pin!.file, FILE);
  assert.equal(pin!.test, "renders the empty listing");
  assert.deepEqual(pin!.pages, [EMPTY_PAGE]);
});

test("a navigation in a beforeEach opens the window the test body asserts in, under the describe's title", () => {
  const pins = pinsOf(`${IMPORTS}
test.describe("listing", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("${EMPTY_PAGE}");
  });
  test("shows no items", async ({ page }) => {
    await test.step("read the list", async () => {
      await expect(page.getByRole("listitem")).toHaveCount(0);
    });
  });
});
`, [passed("listing › shows no items")]);
  assert.deepEqual(pins.map((p) => p.test), ["listing › shows no items"]);
});

test("an empty state the test produces after a step of its own is no ambient pin", () => {
  const pins = pinsOf(`${IMPORTS}
test("filtering to nothing shows the empty state", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await page.getByRole("button", { name: "Only open now" }).click();
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});
`, [passed("filtering to nothing shows the empty state")]);
  assert.deepEqual(pins, []);
});

test("an assertion after a step of the test's own keeps the whole case out, even when it also asserted the page as loaded", () => {
  const pins = pinsOf(`${IMPORTS}
test("clears the filters", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("button", { name: "Clear" })).toBeHidden();
});
`, [passed("clears the filters")]);
  assert.deepEqual(pins, []);
});

test("a page the pack did not read as a confirmed empty state yields no pin", () => {
  const spec = `${IMPORTS}
test("renders the listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByRole("list")).toBeVisible();
});
`;
  assert.deepEqual(pinsOf(spec, [passed("renders the listing")], []), []);
  assert.deepEqual(pinsOf(spec, [passed("renders the listing")], ["/other"]), []);
});

test("a case that did not pass, or a test with no passing case, yields no pin", () => {
  const spec = `${IMPORTS}
test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});
`;
  assert.deepEqual(pinsOf(spec, [{ ...passed("renders the empty listing"), status: "flaky" }]), []);
  assert.deepEqual(pinsOf(spec, []), []);
});

test("a spec that cannot be read soundly yields no pin", async (t) => {
  const unreadable: Record<string, string> = {
    "a computed title": `const where = "${EMPTY_PAGE}";
test(\`renders \${where}\`, async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "a navigation through a helper": `import { openListing } from "./helpers";
test("renders the empty listing", async ({ page }) => {
  await openListing(page);
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "a computed address": `test("renders the empty listing", async ({ page, baseURL }) => {
  await page.goto(\`\${baseURL}${EMPTY_PAGE}\`);
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "an address with a query": `test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}?open=1");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "a fixture that may arrange state": `test("renders the empty listing", async ({ page, seededAccount }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "a step before the first navigation": `test("renders the empty listing", async ({ page }) => {
  await page.context().setGeolocation({ latitude: 1, longitude: 2 });
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "a beforeAll in its scope": `test.beforeAll(async ({ browser }) => {
  await browser.newPage();
});
test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "a test.use in its scope": `test.use({ geolocation: { latitude: 1, longitude: 2 } });
test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`,
    "a title path two tests share": `for (const _ of [1, 2]) {
  test("renders the empty listing", async ({ page }) => {
    await page.goto("${EMPTY_PAGE}");
    await expect(page.getByText("Nothing here yet")).toBeVisible();
  });
}`,
    "a syntax error": `test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible(;
});`,
  };
  for (const [why, body] of Object.entries(unreadable)) {
    await t.test(why, () => {
      assert.deepEqual(pinsOf(`${IMPORTS}${body}\n`, [passed("renders the empty listing"), passed("renders /listing")]), []);
    });
  }
});

test("a case that asserts nothing yields no pin", () => {
  const pins = pinsOf(`${IMPORTS}
test("opens the listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
});
`, [passed("opens the listing")]);
  assert.deepEqual(pins, []);
});

test("a spec whose own code can arrange state outside the test body yields no pin", async (t) => {
  const BODY = `test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});`;
  const arranging: Record<string, string> = {
    "an auto fixture the spec declares": `import { test as base, expect } from "../fixtures";
const test = base.extend<{ clear: void }>({
  clear: [async ({ page }, use) => {
    await page.goto("/admin");
    await page.getByRole("button", { name: "Delete all" }).click();
    await use();
  }, { auto: true }],
});
${BODY}`,
    "a page fixture the spec overrides": `import { test as base, expect } from "../fixtures";
const test = base.extend({
  page: async ({ page }, use) => {
    await page.goto("${EMPTY_PAGE}");
    await page.getByRole("button", { name: "Clear" }).click();
    await use(page);
  },
});
${BODY}`,
    "a test renamed from another binding": `import { test as base, expect } from "../fixtures";
const test = base;
${BODY}`,
    "a serial mode the scope configures": `${IMPORTS}test.describe.configure({ mode: "serial" });
${BODY}`,
    "a serial describe": `${IMPORTS}test.describe.serial("listing", () => {
${BODY}
});`,
    "code that runs when the file loads": `${IMPORTS}await fetch("https://dev.example/api/items", { method: "DELETE" });
${BODY}`,
    "a describe that runs code while its tests are collected": `${IMPORTS}test.describe("listing", () => {
  const seeded = seedItems();
${BODY}
});`,
  };
  for (const [why, text] of Object.entries(arranging)) {
    await t.test(why, () => {
      const cases = [passed("renders the empty listing"), passed("listing › renders the empty listing")];
      assert.deepEqual(pinsOf(`${text}\n`, cases), []);
    });
  }
});

test("declarations that run nothing when the file loads keep a spec readable", () => {
  const text = `${IMPORTS}import type { Page } from "@playwright/test";
type Row = { name: string };
interface Shape { rows: Row[] }
const LISTING = "${EMPTY_PAGE}";
const LABELS = { empty: "Nothing here yet" } as const;
const open = async (page: Page) => page.goto(LISTING);
function heading(page: Page) { return page.getByRole("heading"); }
test.describe.configure({ mode: "parallel" });
test("renders the empty listing", async ({ page }) => {
  await page.goto("${EMPTY_PAGE}");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
});
`;
  assert.deepEqual(pinsOf(text, [passed("renders the empty listing")]), [{ file: FILE, test: "renders the empty listing", pages: [EMPTY_PAGE] }]);
});

/* ── A page DEV served with results: the count it showed is DEV's data of the moment ───────────────── */

const LIVE_PAGE = "/search";
const countsOf = (text: string, cases: QaCase[], read = 4, page = LIVE_PAGE) =>
  detectAmbientDataPins({ specs: [{ file: FILE, text }], cases, emptyPages: [], liveCounts: [{ path: page, resultCount: read }] });
const loadedAssertion = (assertion: string): string => `${IMPORTS}
test("shows the results", async ({ page }) => {
  await page.goto("${LIVE_PAGE}");
  ${assertion}
});
`;

test("a passing case whose as-loaded assertion holds the number of results the Context Pack read on that page is a pin naming the page and the count", () => {
  const byText = countsOf(loadedAssertion(`await expect(page.getByText("4 resultados")).toBeVisible();`), [passed("shows the results")]);
  assert.equal(byText.length, 1);
  assert.deepEqual(byText[0]!.counts, [{ page: LIVE_PAGE, count: 4 }]);
  assert.deepEqual(byText[0]!.pages, [], "no page is empty");

  const byCount = countsOf(loadedAssertion(`await expect(page.getByRole("article")).toHaveCount(4);`), [passed("shows the results")]);
  assert.deepEqual(byCount.map((p) => p.test), ["shows the results"]);
});

test("a number that is not the page's read count, or only part of another number, pins nothing", () => {
  for (const literal of ["5 resultados", "14 resultados", "4.5 km", "Mostrando resultados", "h4"]) {
    assert.deepEqual(countsOf(loadedAssertion(`await expect(page.getByText("${literal}")).toBeVisible();`), [passed("shows the results")]), [], literal);
  }
  assert.equal(countsOf(loadedAssertion(`await expect(page.getByText("Mostrando 4 de 9 resultados")).toBeVisible();`), [passed("shows the results")]).length, 1, "the count as one whole number among others");
});

test("a count asserted after a step of the test's own, on a page the pack read no count for, or by a case that did not pass, is no pin", () => {
  const afterStep = countsOf(`${IMPORTS}
test("filters the results", async ({ page }) => {
  await page.goto("${LIVE_PAGE}");
  await page.getByRole("button", { name: "Only open now" }).click();
  await expect(page.getByText("4 resultados")).toBeVisible();
});
`, [passed("filters the results")]);
  assert.deepEqual(afterStep, []);

  const text = loadedAssertion(`await expect(page.getByText("4 resultados")).toBeVisible();`);
  assert.deepEqual(countsOf(text, [passed("shows the results")], 4, "/map"), [], "the pack read another page");
  assert.deepEqual(countsOf(text, [{ ...passed("shows the results"), status: "fail" }]), []);
});

test("an as-loaded count assertion is a pin even when the test goes on to steps of its own, and a locator's own digits are not counts", () => {
  const goesOn = countsOf(`${IMPORTS}
test("shows then filters", async ({ page }) => {
  await page.goto("${LIVE_PAGE}");
  await expect(page.getByText("4 resultados")).toBeVisible();
  await page.getByRole("button", { name: "Only open now" }).click();
  await expect(page.getByText("Cargando")).toBeHidden();
});
`, [passed("shows then filters")]);
  assert.deepEqual(goesOn.map((p) => p.test), ["shows then filters"]);

  const selector = countsOf(`${IMPORTS}
test("shows the fourth card", async ({ page }) => {
  await page.goto("${LIVE_PAGE}");
  await expect(page.locator("li:nth-child(4)")).toBeVisible();
  await expect(page.getByRole("article").nth(4)).toBeVisible();
});
`, [passed("shows the fourth card")]);
  assert.deepEqual(selector, []);
});
