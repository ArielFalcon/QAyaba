/* The seed's static gate (config/e2e/eslint.config.js) as an app's `e2e/` runs it: what it refuses before a spec ever reaches DEV. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const SEED_DIR = fileURLToPath(new URL("../../../../../config/e2e/", import.meta.url));

async function errorsOf(source: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: SEED_DIR, overrideConfigFile: `${SEED_DIR}eslint.config.js` });
  const [result] = await eslint.lintText(source, { filePath: `${SEED_DIR}flows/sample.spec.ts` });
  return (result?.messages ?? []).filter((message) => message.severity === 2).map((message) => message.ruleId ?? "");
}

const spec = (body: string): string =>
  `import { expect } from "@playwright/test";\nimport { test } from "../fixtures";\n\ntest("filters", async ({ page }) => {\n  await page.goto("/search");\n  const offered = await page.getByRole("button").count();\n${body}\n});\n`;

test("an assertion that runs only while a condition on the page holds is refused by the static gate", async () => {
  const errors = await errorsOf(spec(`  if (offered > 0) {\n    expect(offered).toBeGreaterThan(0);\n  }`));

  assert.ok(errors.includes("playwright/no-conditional-expect"), errors.join(", "));
});

test("an assertion that always runs passes the static gate", async () => {
  const errors = await errorsOf(spec(`  expect(offered).toBeGreaterThan(0);`));

  assert.deepEqual(errors, []);
});

test("a comment in a spec cannot switch a rule of the seed's static gate off", async () => {
  const errors = await errorsOf(spec(`  if (offered > 0) {\n    // eslint-disable-next-line playwright/no-conditional-expect\n    expect(offered).toBeGreaterThan(0);\n  }`));

  assert.ok(errors.includes("playwright/no-conditional-expect"), errors.join(", "));
});
