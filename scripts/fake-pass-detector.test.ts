import { test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_FLAG, detectFakeSpec, type FakeFlag } from "./fake-pass-detector.ts";

const kinds = (flags: readonly FakeFlag[]): string[] => flags.map((f) => f.kind).sort();

const REAL = `
import { test, expect } from "@playwright/test";
test.describe("address", () => {
  test("a duplicate address is refused", async ({ page }) => {
    await page.goto("/user/address/new");
    const banner = page.getByRole("alert");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(banner).toContainText("already");
    await expect(page.getByTestId("address-list")).toBeVisible();
  });
});
`;

test("a spec that asserts on a locator it built is not flagged", () => {
  assert.deepEqual(detectFakeSpec("address.spec.ts", REAL), []);
});

test("an assertion on a value read from the page counts, whether inline or through a variable", () => {
  const source = `
    import { test, expect } from "@playwright/test";
    test("count", async ({ page }) => {
      await page.goto("/");
      const rows = await page.locator("tr").count();
      expect(rows).toBeGreaterThan(0);
      expect(await page.title()).toContain("Shop");
    });`;
  assert.deepEqual(detectFakeSpec("rows.spec.ts", source), []);
});

test("an HTTP response asserted through the request fixture counts as an observation of the system", () => {
  const source = `
    import { test, expect } from "@playwright/test";
    test("api", async ({ request }) => {
      const response = await request.get("/health");
      expect(response.status()).toBe(200);
    });`;
  assert.deepEqual(detectFakeSpec("health.spec.ts", source), []);
});

test("expect(true).toBe(true) is a tautology and flags the whole spec", () => {
  const source = `
    import { test, expect } from "@playwright/test";
    test("passes", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("h1")).toBeVisible();
      expect(true).toBe(true);
    });`;
  assert.deepEqual(kinds(detectFakeSpec("t.spec.ts", source)), [FAKE_FLAG.TAUTOLOGY]);
});

test("literal-vs-literal expectations are tautologies", () => {
  for (const line of ['expect(1 + 1).toBe(2);', 'expect("a").toBe("a");', "expect(null).toBeNull();", "expect(42).toBeGreaterThan(1);"]) {
    const source = `import { test, expect } from "@playwright/test";\ntest("x", async ({ page }) => {\n await page.goto("/");\n await expect(page.locator("h1")).toBeVisible();\n ${line}\n});`;
    assert.ok(kinds(detectFakeSpec("t.spec.ts", source)).includes(FAKE_FLAG.TAUTOLOGY), line);
  }
});

test("a spec whose only expectations are on literals is also missing a page expectation", () => {
  const source = `import { test, expect } from "@playwright/test";\ntest("x", async ({ page }) => { await page.goto("/"); expect(true).toBe(true); });`;
  assert.deepEqual(kinds(detectFakeSpec("t.spec.ts", source)), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.TAUTOLOGY]);
});

test("a spec that navigates and asserts nothing is flagged", () => {
  const source = `import { test } from "@playwright/test";\ntest("x", async ({ page }) => { await page.goto("/"); await page.click("a"); });`;
  assert.deepEqual(kinds(detectFakeSpec("nav.spec.ts", source)), [FAKE_FLAG.NO_PAGE_EXPECT]);
});

test("an empty test body is flagged even when another test asserts", () => {
  const source = `${REAL}\ntest("later", async ({ page }) => {});\ntest("sync", () => { /* nothing */ });`;
  assert.deepEqual(kinds(detectFakeSpec("a.spec.ts", source)), [FAKE_FLAG.EMPTY_BODY, FAKE_FLAG.EMPTY_BODY]);
});

test("a file with no test at all is flagged", () => {
  assert.deepEqual(kinds(detectFakeSpec("a.spec.ts", "// nothing here\nexport const x = 1;\n")), [FAKE_FLAG.NO_TESTS]);
  assert.deepEqual(kinds(detectFakeSpec("a.spec.ts", "")), [FAKE_FLAG.NO_TESTS]);
});

test("files named like probes are flagged whatever they assert", () => {
  for (const path of ["_explore.spec.ts", "_register.spec.ts", "tmp.spec.ts", "scratch.spec.ts", "flows/tmp-checkout.spec.ts", "flows/probe.login.spec.ts", "flows/_x.spec.ts"]) {
    assert.ok(kinds(detectFakeSpec(path, REAL)).includes(FAKE_FLAG.PROBE_NAME), path);
  }
});

test("a feature named like a probe word inside a longer word is not flagged", () => {
  for (const path of ["user-register.spec.ts", "exploration-map.spec.ts", "template.spec.ts", "attempt.spec.ts"]) {
    assert.ok(!kinds(detectFakeSpec(path, REAL)).includes(FAKE_FLAG.PROBE_NAME), path);
  }
});

test("a commented-out assertion or test does not count", () => {
  const source = `
    import { test, expect } from "@playwright/test";
    // test("old", async ({ page }) => { await expect(page.locator("h1")).toBeVisible(); });
    test("new", async ({ page }) => {
      await page.goto("/");
      /* await expect(page.locator("h1")).toBeVisible(); */
    });`;
  assert.deepEqual(kinds(detectFakeSpec("c.spec.ts", source)), [FAKE_FLAG.NO_PAGE_EXPECT]);
});

test("text inside strings is not read as code", () => {
  const source = `
    import { test, expect } from "@playwright/test";
    test("quotes", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByText("expect(true).toBe(true) } test(")).toBeVisible();
    });`;
  assert.deepEqual(detectFakeSpec("q.spec.ts", source), []);
});

test("expect(page).toBeTruthy() asserts nothing about the page", () => {
  const source = `import { test, expect } from "@playwright/test";\ntest("x", async ({ page }) => { await page.goto("/"); expect(page).toBeTruthy(); });`;
  assert.deepEqual(kinds(detectFakeSpec("v.spec.ts", source)), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]);
});

test("a flag names what it found so the owner can read it", () => {
  const flags = detectFakeSpec("t.spec.ts", `import { test, expect } from "@playwright/test";\ntest("x", async ({ page }) => { expect(true).toBe(true); });`);
  const tautology = flags.find((f) => f.kind === FAKE_FLAG.TAUTOLOGY);
  assert.ok(tautology?.detail.includes("expect(true)"));
});

test("expect.soft and expect.poll on page values count, test.step bodies are scanned", () => {
  const source = `
    import { test, expect } from "@playwright/test";
    test("steps", async ({ page }) => {
      await test.step("open", async () => { await page.goto("/"); });
      await expect.soft(page.locator("h1")).toBeVisible();
      await expect.poll(async () => (await page.locator("li").count())).toBeGreaterThan(0);
    });`;
  assert.deepEqual(detectFakeSpec("s.spec.ts", source), []);
});
