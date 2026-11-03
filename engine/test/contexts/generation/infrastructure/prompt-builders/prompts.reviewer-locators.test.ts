import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { deriveReviewerContext, REVIEWER_FRAGILE_LOCATORS_SECTION_ID, REVIEWER_SECTIONS } from "@contexts/generation/infrastructure/prompt-builders/reviewer-sections.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";

/* The reviewer is shown the locators that are not role/test-id/label/text based, read out of the
   spec text by the orchestrator, so it judges only whether an alternative exists. The list is
   advisory by construction: it reaches a prompt and nothing else, and the reviewer's own class
   rules decide what each candidate is worth. */

const WITH_LOCATOR = [
  `import { test, expect } from "./fixtures";`,
  `test("applies a coupon", async ({ page }) => {`,
  `  await page.goto("/cart");`,
  `  await page.locator(".btn-primary").click();`,
  `  await page.locator("xpath=//div[@role='cell']").click();`,
  `  await expect(page.getByRole("heading", { name: "Cart" })).toBeVisible();`,
  `});`,
].join("\n");

const WITHOUT_LOCATOR = [
  `import { test, expect } from "./fixtures";`,
  `test("applies a coupon", async ({ page }) => {`,
  `  await page.goto("/cart");`,
  `  await page.getByRole("button", { name: "Apply coupon" }).click();`,
  `});`,
].join("\n");

function withReviewerSpec<T>(body: string, run: (mirror: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "qa-reviewer-locators-"));
  try {
    const mirror = join(tmp, "mirror");
    mkdirSync(join(mirror, "e2e", "flows"), { recursive: true });
    writeFileSync(join(mirror, "e2e", "flows", "cart.spec.ts"), body);
    return run(mirror);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const reviewOf = (mirror: string): ReviewInput => ({
  diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export const total = 1;",
  specs: ["flows/cart.spec.ts"],
  mirrorDir: mirror,
  e2eRelDir: "e2e",
  appName: "shop",
  mode: "diff",
  baseUrl: "http://localhost:3000",
});

test("the reviewer is shown each fragile locator with the spec it is in, and no section appears without one", (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  const withLocators = withReviewerSpec(WITH_LOCATOR, (mirror) => buildReviewerPromptAssembled(reviewOf(mirror)));
  assert.ok(Object.keys(withLocators.sectionSizes).includes(REVIEWER_FRAGILE_LOCATORS_SECTION_ID), "the section is in the prompt");
  assert.match(withLocators.text, /e2e\/flows\/cart\.spec\.ts: \.locator\("\.btn-primary"\)/);
  assert.match(withLocators.text, /e2e\/flows\/cart\.spec\.ts: \.locator\("xpath=/, "an xpath argument is named with its call");
  assert.ok(!withLocators.text.includes(`getByRole("button"`), "a role locator is not a candidate");
  assert.ok(logged.some((line) => /2 fragile locator candidate\(s\) in 1 spec/.test(line)), "the counts are told as telemetry");

  const clean = withReviewerSpec(WITHOUT_LOCATOR, (mirror) => buildReviewerPromptAssembled(reviewOf(mirror)));
  assert.ok(!Object.keys(clean.sectionSizes).includes(REVIEWER_FRAGILE_LOCATORS_SECTION_ID), "no candidate, no section");
});

test("a prompt that fits only with the specs named as references carries no locator list: no file is read a second time", () => {
  const assembled = withReviewerSpec(WITH_LOCATOR, (mirror) => buildReviewerPromptAssembled(reviewOf(mirror), { fit: () => "over" as const }));
  assert.equal(Object.keys(assembled.sectionSizes).includes("reviewer-specs"), true);
  assert.ok(!Object.keys(assembled.sectionSizes).includes(REVIEWER_FRAGILE_LOCATORS_SECTION_ID));
  assert.ok(!assembled.text.includes(`.locator(".btn-primary")`), "no locator is listed from a spec the prompt does not show");
});

test("over the window the locator section gives way to per-spec counts, and the render it gives way to is smaller", () => {
  const section = REVIEWER_SECTIONS.find((candidate) => candidate.id === REVIEWER_FRAGILE_LOCATORS_SECTION_ID);
  assert.ok(section, "the locator section is registered");
  const ctx = withReviewerSpec(WITH_LOCATOR, (mirror) => deriveReviewerContext(reviewOf(mirror)));
  const whole = section.render(ctx);
  const degraded = whole.degrade?.(1);
  assert.ok(degraded, "the section can give way");
  assert.ok(Buffer.byteLength(degraded.content, "utf8") < Buffer.byteLength(whole.content, "utf8"), "a step that would not shrink the section is not a step");
  assert.match(degraded.content, /e2e\/flows\/cart\.spec\.ts: 2/, "the spec and how many candidates it holds");
  assert.ok(!degraded.content.includes(".btn-primary"), "no candidate is listed when none is shown");
});
