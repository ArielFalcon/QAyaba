/* The failure classifier is pinned to the error wording of Playwright 1.60.0 (the version the image pins). When Playwright moves, these fixtures are re-recorded from the new version's messages (AGENTS.md, "When Playwright moves"). */
/* Provenance of the fixtures. Fragments confirmed in the 1.60.0 sources under node_modules/playwright-core and node_modules/playwright: the
   "strict mode violation: <locator> resolved to N elements:" line, "waiting for <locator>", "unexpected value", "<element(s) not found>",
   "locator resolved to hidden", "intercepts pointer events", "Timeout Nms exceeded", the "Expected:"/"Received:" labels and "Call log:".
   The whole-message layouts (line order, indentation, the surrounding Error: prefixes) and the 401/403, redirect-to-login and net::ERR_ messages
   are written from memory of real runs and are PENDING live re-recording against a Playwright 1.60 run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILURE_CATEGORY, classifyFailure, locatorStrategy, strictModeMatchCount } from "@contexts/test-execution/domain/failure-category.ts";

/* Messages as Playwright 1.60 words them. */
const FIXTURES = {
  strict: `Error: expect.toBeVisible: Error: strict mode violation: getByRole('button', { name: 'Save' }) resolved to 2 elements:\n    1) <button type="submit">Save</button> aka getByTestId('save-top')\n    2) <button type="button">Save draft</button> aka getByTestId('save-draft')\n\nCall log:\n  - Expect "toBeVisible" with timeout 5000ms\n  - waiting for getByRole('button', { name: 'Save' })`,
  clickNotFound: `Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('missing-btn')`,
  expectNotFound: `Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('banner')\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 5000ms`,
  hidden: `Error: locator.fill: Error: element is not visible\nCall log:\n  - waiting for locator('#email')\n  -   locator resolved to hidden <input id="email"/>`,
  testTimeout: `Test timeout of 30000ms exceeded.`,
  gotoTimeout: `Error: page.goto: Timeout 10000ms exceeded.\nCall log:\n  - navigating to "https://dev.example.com/", waiting until "load"`,
  assertText: `Error: expect(locator).toHaveText(expected) failed\n\nLocator: locator('h1')\nExpected string: "Orders"\nReceived string: "Order list"\nTimeout: 5000ms`,
  assertValue: `Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 3\nReceived: 2`,
  authUrl: `Error: expect(page).toHaveURL(expected) failed\n\nExpected pattern: /dashboard/\nReceived string:  "https://dev.example.com/login?next=%2Fdashboard"\nTimeout: 5000ms`,
  auth401: `Error: apiRequestContext.get: Request failed with status 401 Unauthorized\n  at /api/me`,
  data409: `Error: apiRequestContext.post: Request failed with status code 409: user already exists`,
  netBlocked: `Error: page.goto: net::ERR_CONNECTION_REFUSED at https://cdn.thirdparty.test/lib.js`,
  netOther: `Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://dev.example.com/`,
  browserGone: `Error: page.click: Target page, context or browser has been closed`,
  launch: `Error: browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1200/chrome-linux/chrome`,
  /* The reviewer's counterexamples: an assertion that names a locator, quotes words other rules look for, or carries a call log. */
  textMismatchWithCallLog: `Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId('title')\nExpected string: "Orders"\nReceived string: "Order list"\nTimeout: 5000ms\n\nCall log:\n  - Expect "toHaveText" with timeout 5000ms\n  - waiting for getByTestId('title')\n    9 \u00d7 locator resolved to <h1>Order list</h1>\n      - unexpected value "Order list"`,
  countMismatch: `Error: expect(locator).toHaveCount(expected) failed\n\nLocator: locator('li')\nExpected: 3\nReceived: 2\nTimeout: 5000ms`,
  quotedConflict: `Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole('status')\nExpected: "Conflict resolved"\nReceived: "Saving"\nTimeout: 5000ms`,
  quotedUnauthorized: `Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole('alert')\nExpected: "You are unauthorized"\nReceived: ""\nTimeout: 5000ms`,
  mystery: `TypeError: Cannot read properties of undefined (reading 'map')`,
  coloured: `\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\n\nLocator: getByTestId('banner')\nReceived: <element(s) not found>`,
};

test("a strict mode violation, an element that never appeared and a hidden one are selector failures", () => {
  for (const name of ["strict", "clickNotFound", "expectNotFound", "hidden", "coloured"] as const) {
    assert.equal(classifyFailure(FIXTURES[name]), FAILURE_CATEGORY.SELECTOR, name);
  }
});

test("a timeout that waits for nothing in particular is a timeout", () => {
  assert.equal(classifyFailure(FIXTURES.testTimeout), FAILURE_CATEGORY.TIMEOUT);
  assert.equal(classifyFailure(FIXTURES.gotoTimeout), FAILURE_CATEGORY.TIMEOUT);
});

test("an expectation that compares values is an assertion failure", () => {
  assert.equal(classifyFailure(FIXTURES.assertText), FAILURE_CATEGORY.ASSERTION);
  assert.equal(classifyFailure(FIXTURES.assertValue), FAILURE_CATEGORY.ASSERTION);
});

test("a redirect to a login page and a 401 are auth failures", () => {
  assert.equal(classifyFailure(FIXTURES.authUrl), FAILURE_CATEGORY.AUTH);
  assert.equal(classifyFailure(FIXTURES.auth401), FAILURE_CATEGORY.AUTH);
});

test("a conflict with data the app already holds is a data-state failure", () => {
  assert.equal(classifyFailure(FIXTURES.data409), FAILURE_CATEGORY.DATA_STATE);
});

test("a network error naming a host the egress filter refused is an egress failure, and one naming any other is infra", () => {
  assert.equal(classifyFailure(FIXTURES.netBlocked, { deniedHosts: ["cdn.thirdparty.test"] }), FAILURE_CATEGORY.EGRESS);
  assert.equal(classifyFailure(FIXTURES.netBlocked), FAILURE_CATEGORY.INFRA);
  assert.equal(classifyFailure(FIXTURES.netOther, { deniedHosts: ["cdn.thirdparty.test"] }), FAILURE_CATEGORY.INFRA);
});

test("a closed browser and a missing executable are infra failures", () => {
  assert.equal(classifyFailure(FIXTURES.browserGone), FAILURE_CATEGORY.INFRA);
  assert.equal(classifyFailure(FIXTURES.launch), FAILURE_CATEGORY.INFRA);
});

test("a message no rule knows, and an empty one, stay unclassified", () => {
  assert.equal(classifyFailure(FIXTURES.mystery), undefined);
  assert.equal(classifyFailure(""), undefined);
});

test("the number of elements a strict mode violation resolved to is read from the message", () => {
  assert.equal(strictModeMatchCount(FIXTURES.strict), 2);
  assert.equal(strictModeMatchCount("Error: locator.click: Error: strict mode violation: locator('li') resolved to 14 elements:"), 14);
  assert.equal(strictModeMatchCount("strict mode violation: getByText('x') resolved to 1 element"), 1);
});

test("a message that is not a strict mode violation has no match count", () => {
  assert.equal(strictModeMatchCount(FIXTURES.expectNotFound), undefined);
  assert.equal(strictModeMatchCount("strict mode violation without a number"), undefined);
});

test("the kind of locator that failed is read from the first locator the message names", () => {
  assert.equal(locatorStrategy(FIXTURES.clickNotFound), "testid");
  assert.equal(locatorStrategy(FIXTURES.strict), "role");
  assert.equal(locatorStrategy(`waiting for getByText('Welcome')`), "text");
  assert.equal(locatorStrategy(`waiting for getByLabel('Email')`), "text");
  assert.equal(locatorStrategy(FIXTURES.hidden), "css");
  assert.equal(locatorStrategy(`waiting for locator('[data-testid="row"]')`), "testid");
  assert.equal(locatorStrategy(FIXTURES.assertValue), undefined);
});

test("an expectation that names a locator, carries a call log or quotes words other rules look for is still an assertion failure", () => {
  for (const name of ["textMismatchWithCallLog", "countMismatch", "quotedConflict", "quotedUnauthorized"] as const) {
    assert.equal(classifyFailure(FIXTURES[name]), FAILURE_CATEGORY.ASSERTION, name);
  }
});

test("data state and auth are read from an HTTP status, never from words in an assertion", () => {
  assert.equal(classifyFailure("Error: page.goto: response status 409 Conflict"), FAILURE_CATEGORY.DATA_STATE);
  assert.equal(classifyFailure("Error: apiRequestContext.post: status 409"), FAILURE_CATEGORY.DATA_STATE);
  assert.equal(classifyFailure("Error: page.goto: response status 403 Forbidden"), FAILURE_CATEGORY.AUTH);
});

test("an assertion that mentions a status is still an assertion: the status only counts when the failure is no assertion", () => {
  assert.equal(classifyFailure("Error: expect(locator).toHaveCount(expected) failed\n\nLocator: locator('li')\nExpected: 3\nReceived: 404\nTimeout: 5000ms"), FAILURE_CATEGORY.ASSERTION);
  assert.equal(classifyFailure('Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole(\'alert\')\nExpected: "status 409"\nReceived: ""'), FAILURE_CATEGORY.ASSERTION);
  assert.equal(classifyFailure("Error: expect(response).toBeOK()\n\nReceived: 401 Unauthorized"), FAILURE_CATEGORY.ASSERTION);
  /* A selector marker or an infra one still wins over the assertion that carries it. */
  assert.equal(classifyFailure("Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('x')\nReceived: <element(s) not found>"), FAILURE_CATEGORY.SELECTOR);
});
