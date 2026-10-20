/* The summary of a Playwright failure a span carries: what it keeps and what it drops. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizePlaywrightFailure } from "@contexts/test-execution/domain/playwright-error-summary.ts";

test("a toBeVisible assertion keeps its first line and its Locator, Expected, Received and Timeout labels", () => {
  const message = `Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('banner')\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 5000ms`;
  const summary = summarizePlaywrightFailure(message);
  assert.match(summary, /^Error: expect\(locator\)\.toBeVisible\(\) failed$/m);
  assert.match(summary, /^Locator: getByTestId\('banner'\)$/m);
  assert.match(summary, /^Expected: visible$/m);
  assert.match(summary, /^Received: <element\(s\) not found>$/m);
  assert.match(summary, /^Timeout: 5000ms$/m);
});

test("a locator action with a call log keeps at most two top-level call-log entries", () => {
  const message = `Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('missing-btn')\n  -   locator resolved to hidden <input id="x"/>\n  - a third entry that must not appear\n      - nested sub-line`;
  const summary = summarizePlaywrightFailure(message);
  assert.match(summary, /^Error: locator\.click: Test timeout of 30000ms exceeded\.$/m);
  assert.match(summary, /^  - waiting for getByTestId\('missing-btn'\)$/m);
  assert.match(summary, /^  -   locator resolved to hidden <input id="x"\/>$/m);
  assert.equal(summary.includes("a third entry"), false);
  assert.equal(summary.includes("nested sub-line"), false);
});

test("an ANSI-coloured message is stripped and capped at 500 characters", () => {
  const message = `\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\n\nLocator: getByTestId('${"banner-".repeat(80)}')\nReceived: <element(s) not found>`;
  const summary = summarizePlaywrightFailure(message);
  assert.equal(summary.includes("\u001b"), false);
  assert.ok(summary.length <= 500);
  assert.match(summary, /^Error: expect\(locator\)\.toBeVisible\(\) failed$/m);
});
