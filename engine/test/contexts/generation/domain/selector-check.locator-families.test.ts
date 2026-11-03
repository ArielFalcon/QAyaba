import { test } from "node:test";
import assert from "node:assert/strict";
import { fragileLocatorCalls } from "@contexts/generation/domain/selector-check.ts";

/* The locator families the reviewer's own rule calls fragile, and the seed's static gate states
   nothing about: a `.locator(...)` call, whatever argument it takes, and a bare `xpath=` selector.
   Advisory by construction — only the reviewer can judge whether a role, test-id, label or text
   alternative exists — so the lint names candidates and never a finding. */

test("fragileLocatorCalls: a CSS locator, a template argument and an xpath argument are candidates", () => {
  const spec = [
    `await page.locator(".btn-primary").click();`,
    "await page.locator(`#row-${id}`).click();",
    `await page.locator("xpath=//div[@role='cell']").click();`,
  ].join("\n");
  assert.deepEqual(fragileLocatorCalls(spec), [
    `.locator(".btn-primary")`,
    ".locator(`#row-${id}`)",
    `.locator("xpath=//div[@role='cell']")`,
  ]);
});

test("fragileLocatorCalls: a bare xpath selector outside a .locator call is a candidate", () => {
  assert.deepEqual(fragileLocatorCalls(`await page.fill("xpath=//input", "x");`), ["xpath=//input"]);
});

test("fragileLocatorCalls: role, test-id, label, text, placeholder, alt-text and title locators are never candidates", () => {
  const spec = [
    `await page.getByRole("button", { name: "Save" }).click();`,
    `await page.getByTestId("save").click();`,
    `await page.getByLabel("Name").fill("x");`,
    `await page.getByText("Saved").click();`,
    `await page.getByPlaceholder("Search").fill("x");`,
    `await page.getByAltText("Logo").click();`,
    `await page.getByTitle("Help").click();`,
  ].join("\n");
  assert.deepEqual(fragileLocatorCalls(spec), []);
});

test("fragileLocatorCalls: a commented-out locator is not a candidate", () => {
  const spec = [
    `// await page.locator(".old-class").click();`,
    `/* await page.locator(".older-class").click(); */`,
    `await page.getByRole("button", { name: "Save" }).click();`,
  ].join("\n");
  assert.deepEqual(fragileLocatorCalls(spec), []);
});

test("fragileLocatorCalls: a call wrapped over several lines is one candidate, and the same locator is named once", () => {
  const spec = ["await page", `  .locator(`, `    ".btn-primary",`, `  )`, `  .click();`, `await page.locator(".btn-primary").click();`].join("\n");
  assert.deepEqual(fragileLocatorCalls(spec), [`.locator(".btn-primary")`]);
});

test("fragileLocatorCalls: an options object is part of the same call, so it is one candidate and its brackets do not end it", () => {
  const spec = [`await page.locator(".row", { hasText: "Save" }).click();`, "await page.locator(`.row-${id}`, { has: page.locator(\".cell\") }).click();"].join("\n");
  assert.deepEqual(fragileLocatorCalls(spec), [`.locator(".row")`, ".locator(`.row-${id}`)", `.locator(".cell")`]);
});
