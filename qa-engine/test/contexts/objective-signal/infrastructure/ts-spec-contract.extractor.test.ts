/* TS-AST spec-contract extraction: one clause per locator chain and per assertion, opacity for anything
   that is not statically a literal, and the opacity ratio the run records. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSpecContract,
  opacityIsHigh,
} from "@contexts/objective-signal/infrastructure/ts-spec-contract.extractor.ts";

const SPEC = `test("checkout", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Pay now" })).toHaveText("Pay now");
});`;

test("a literal chain yields its expected value, matcher strength and scope", () => {
  const { specs, clauseCount, opaqueCount } = extractSpecContract("e2e/a.spec.ts", SPEC);
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.testName, "checkout");
  assert.equal(clauseCount, 2, "one clause per locator chain and one per assertion");
  assert.equal(opaqueCount, 0);

  const assertion = specs[0]!.clauses.find((clause) => clause.kind === "assertion");
  assert.equal(assertion?.expected, "Pay now");
  assert.equal(assertion?.strength, "exact");

  const locator = specs[0]!.clauses.find((clause) => clause.kind === "locator");
  assert.deepEqual(locator?.scope, ["getByRole"]);
  assert.deepEqual(locator?.positional, []);
  assert.equal(locator?.opaque, false);
});

test("a locator built from a variable is opaque, so a change to it can never reject", () => {
  const source = `test("checkout", async ({ page }) => {
    const label = process.env.LABEL ?? "x";
    await expect(page.getByText(label)).toBeVisible();
  });`;
  const { specs, opaqueCount, clauseCount } = extractSpecContract("e2e/a.spec.ts", source);
  assert.equal(opaqueCount, clauseCount, "every clause that names a variable is opaque");
  assert.ok(specs[0]!.clauses.every((clause) => clause.opaque));
});

test("a locator built in a helper loop is opaque", () => {
  const source = `test("rows", async ({ page }) => {
    for (const name of names) {
      await page.getByText(name).click();
    }
  });`;
  const { specs } = extractSpecContract("e2e/a.spec.ts", source);
  const locator = specs[0]!.clauses.find((clause) => clause.kind === "locator");
  assert.equal(locator?.opaque, true);
});

test("an opacity ratio above the configured threshold is flagged, and one below is not", () => {
  const source = `test("mixed", async ({ page }) => {
    await expect(page.getByText("Total")).toBeVisible();
    await page.getByText(dynamicLabel).click();
  });`;
  const extraction = extractSpecContract("e2e/a.spec.ts", source);
  assert.equal(extraction.clauseCount, 3);
  assert.equal(extraction.opaqueCount, 1);
  assert.equal(opacityIsHigh(extraction, 0.3), true);
  assert.equal(opacityIsHigh(extraction, 0.4), false);
});

test("positional steps and negation are read from the chain", () => {
  const source = `test("cart", async ({ page }) => {
    await expect(page.locator(".row").filter({ hasText: "Book" }).last()).not.toBeVisible();
  });`;
  const { specs } = extractSpecContract("e2e/a.spec.ts", source);
  const positional = specs[0]!.clauses.find((clause) => clause.positional.length > 0);
  assert.deepEqual(positional?.positional, ["last"]);
  assert.deepEqual(positional?.scope, ["locator", "filter"]);

  const assertion = specs[0]!.clauses.find((clause) => clause.kind === "assertion");
  assert.equal(assertion?.negated, true);
  assert.equal(assertion?.strength, "presence");
});

test("a file that does not parse yields no contract", () => {
  const extraction = extractSpecContract("e2e/broken.spec.ts", `test("x", async ({ page }) => {`);
  assert.deepEqual(extraction.specs, []);
  assert.equal(extraction.clauseCount, 0);
});
