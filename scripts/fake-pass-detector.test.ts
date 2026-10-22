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

/* ── vacuity the detector must see, whatever the argument and wherever in the file ── */

const wrap = (body: string, extra = ""): string =>
  `import { test, expect } from "@playwright/test";\n${extra}\ntest("x", async ({ page }) => {\n await page.goto("/");\n${body}\n});`;
const REAL_EXPECT = ' await expect(page.getByTestId("list")).toBeVisible();';

const VACUOUS_CASES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["a locator expected truthy", wrap(' expect(page.locator("#app")).toBeTruthy();'), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["a locator expected defined", wrap(' expect(page.getByRole("button")).toBeDefined();'), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["a locator expected not null", wrap(' expect(page.locator("li").first()).not.toBeNull();'), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["a locator held in a variable expected truthy", wrap(' const row = page.locator("tr");\n expect(row).toBeTruthy();'), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["a count expected at least zero", wrap(' expect(await page.locator("li").count()).toBeGreaterThanOrEqual(0);'), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["a counted variable expected at least zero", wrap(' const n = await page.locator("li").count();\n expect(n).toBeGreaterThanOrEqual(0);'), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["any URL", wrap(" await expect(page).toHaveURL(/.*/);"), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["any title", wrap(" await expect(page).toHaveTitle(/.*/);"), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.VACUOUS]],
  ["a value equal to itself", wrap(' const title = await page.title();\n expect(title).toBe(title);'), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.TAUTOLOGY]],
  ["the body expected visible as the only assertion", wrap(' await expect(page.locator("body")).toBeVisible();'), [FAKE_FLAG.VACUOUS]],
];

for (const [name, source, expected] of VACUOUS_CASES) {
  test(`${name} is flagged`, () => {
    assert.deepEqual(kinds(detectFakeSpec("v.spec.ts", source)), [...expected].sort());
  });
}

const GENUINE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["a boolean read from a locator expected truthy", wrap(' expect(await page.locator("#app").isVisible()).toBeTruthy();')],
  ["a count expected above zero", wrap(' expect(await page.locator("li").count()).toBeGreaterThan(0);')],
  ["a URL expected to match a path", wrap(" await expect(page).toHaveURL(/\\/orders$/);")],
  ["a title expected to be a string", wrap(' await expect(page).toHaveTitle("Orders");')],
  ["a value compared with another value", wrap(' const a = await page.title();\n expect(a).toBe("Orders");')],
  ["the body visible next to a real assertion", wrap(`${REAL_EXPECT}\n await expect(page.locator("body")).toBeVisible();`)],
];

for (const [name, source] of GENUINE_CASES) {
  test(`${name} is not flagged`, () => {
    assert.deepEqual(detectFakeSpec("g.spec.ts", source), []);
  });
}

/* ── each test body is judged on its own ── */

test("a test with no assertion is flagged although another test of the file asserts", () => {
  const source = `${REAL}\ntest("navigates only", async ({ page }) => { await page.goto("/"); await page.click("a"); });`;
  assert.deepEqual(kinds(detectFakeSpec("two.spec.ts", source)), [FAKE_FLAG.NO_PAGE_EXPECT]);
});

test("a tautology in one test does not hide behind a real assertion in another", () => {
  const source = `${REAL}\ntest("literal", async ({ page }) => { await page.goto("/"); expect(1).toBe(1); });`;
  assert.deepEqual(kinds(detectFakeSpec("two.spec.ts", source)), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.TAUTOLOGY]);
});

test("each test that asserts nothing is flagged once", () => {
  const source = `import { test } from "@playwright/test";\ntest("a", async ({ page }) => { await page.goto("/"); });\ntest("b", async ({ page }) => { await page.goto("/b"); });`;
  assert.deepEqual(kinds(detectFakeSpec("none.spec.ts", source)), [FAKE_FLAG.NO_PAGE_EXPECT, FAKE_FLAG.NO_PAGE_EXPECT]);
});

test("a body that is only the body-visible check is flagged in a file where another test asserts for real", () => {
  const source = `${REAL}\ntest("loads", async ({ page }) => { await page.goto("/"); await expect(page.locator("body")).toBeVisible(); });`;
  assert.deepEqual(kinds(detectFakeSpec("two.spec.ts", source)), [FAKE_FLAG.VACUOUS]);
});

test("an assertion in a helper or hook outside the test bodies counts for the tests of the file", () => {
  const source = `
    import { test, expect } from "@playwright/test";
    test.beforeEach(async ({ page }) => { await page.goto("/"); await expect(page.getByTestId("ready")).toBeVisible(); });
    test("opens", async ({ page }) => { await page.click("a"); });`;
  assert.deepEqual(detectFakeSpec("hook.spec.ts", source), []);
});

/* ── tests that do not run ── */

const SKIP_CASES: ReadonlyArray<readonly [string, string]> = [
  ["a skipped test declaration", `${REAL}\ntest.skip("later", async ({ page }) => { await expect(page.locator("h1")).toBeVisible(); });`],
  ["a fixme test declaration", `${REAL}\ntest.fixme("broken", async ({ page }) => { await expect(page.locator("h1")).toBeVisible(); });`],
  ["a skipped describe", `${REAL}\ntest.describe.skip("group", () => { test("in", async ({ page }) => { await expect(page.locator("h1")).toBeVisible(); }); });`],
  ["an unconditional skip inside a body", wrap(`${REAL_EXPECT}\n test.skip();`)],
  ["a skip that is always true", wrap(`${REAL_EXPECT}\n test.skip(true, "later");`)],
  ["an unconditional fixme inside a body", wrap(`${REAL_EXPECT}\n test.fixme();`)],
];

for (const [name, source] of SKIP_CASES) {
  test(`${name} is flagged as a test that does not run`, () => {
    assert.ok(kinds(detectFakeSpec("s.spec.ts", source)).includes(FAKE_FLAG.SKIPPED));
  });
}

test("a spec whose only tests are skipped has no test and is skipped", () => {
  const source = `import { test, expect } from "@playwright/test";\ntest.skip("later", async ({ page }) => { await expect(page.locator("h1")).toBeVisible(); });`;
  assert.deepEqual(kinds(detectFakeSpec("s.spec.ts", source)), [FAKE_FLAG.NO_TESTS, FAKE_FLAG.SKIPPED]);
});

test("a skip that depends on a condition is not a skipped test", () => {
  const source = wrap(`${REAL_EXPECT}\n test.skip(process.env.CI === "1", "flaky on CI");\n test.skip(browserName === "webkit", "no webkit");`);
  assert.deepEqual(detectFakeSpec("c.spec.ts", source), []);
});
