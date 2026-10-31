import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSpecForReview,
  renderSpecChanges,
  reviewSpecsKey,
  sameReviewedSpecs,
} from "@contexts/generation/domain/review-fingerprint.ts";

const ORIGINAL = `import { test, expect } from "../fixtures";

test("lists restaurants", async ({ page }) => {
  await page.goto("/restaurants");
  await expect(page.getByText("0 resultados")).toBeVisible();
});
`;

test("a comment-only change (full-line or block) is not a material change", () => {
  const commented = `// regenerated after the reviewer's correction
import { test, expect } from "../fixtures";

test("lists restaurants", async ({ page }) => {
  /* the reviewer asked for this */
  await page.goto("/restaurants");
  await expect(page.getByText("0 resultados")).toBeVisible();
});
`;
  assert.equal(normalizeSpecForReview(ORIGINAL), normalizeSpecForReview(commented));
  assert.equal(
    sameReviewedSpecs([{ file: "flows/restaurants.spec.ts", text: ORIGINAL }], [{ file: "flows/restaurants.spec.ts", text: commented }]),
    true,
  );
});

test("a trailing line comment counts as material: telling it from a URL inside a string needs a parser, and one extra review never rejects a spec", () => {
  const trailing = ORIGINAL.replace("toBeVisible();", "toBeVisible(); // empty state");
  assert.equal(
    sameReviewedSpecs([{ file: "flows/restaurants.spec.ts", text: ORIGINAL }], [{ file: "flows/restaurants.spec.ts", text: trailing }]),
    false,
  );
});

test("a changed assertion is a material change", () => {
  const fixed = ORIGINAL.replace('"0 resultados"', '"11 restaurantes"');
  assert.equal(
    sameReviewedSpecs([{ file: "flows/restaurants.spec.ts", text: ORIGINAL }], [{ file: "flows/restaurants.spec.ts", text: fixed }]),
    false,
  );
  assert.equal(reviewSpecsKey([{ file: "flows/restaurants.spec.ts", text: ORIGINAL }]) === reviewSpecsKey([{ file: "flows/restaurants.spec.ts", text: fixed }]), false);
});

test("a changed test id inside a string stays material (the comment stripper does not touch quotes)", () => {
  const a = `test("x", async ({ page }) => { await page.goto("/a"); await expect(page.getByTestId("row")).toBeVisible(); });`;
  const b = `test("x", async ({ page }) => { await page.goto("/a"); await expect(page.getByTestId("card")).toBeVisible(); });`;
  assert.notEqual(normalizeSpecForReview(a), normalizeSpecForReview(b));
});

test("an empty round is never 'unchanged'", () => {
  assert.equal(sameReviewedSpecs([], []), false);
});

test("the second round is shown only the lines that changed, and only changed files", () => {
  const fixed = ORIGINAL.replace('"0 resultados"', '"11 restaurantes"');
  const summary = renderSpecChanges(
    [
      { file: "flows/restaurants.spec.ts", text: ORIGINAL },
      { file: "flows/login.spec.ts", text: `test("login", async ({ page }) => { await page.goto("/login"); });` },
    ],
    [
      { file: "flows/restaurants.spec.ts", text: fixed },
      { file: "flows/login.spec.ts", text: `test("login", async ({ page }) => { await page.goto("/login"); });` },
    ],
  );

  assert.match(summary, /### flows\/restaurants\.spec\.ts/);
  assert.match(summary, /- .*0 resultados/);
  assert.match(summary, /\+ .*11 restaurantes/);
  assert.doesNotMatch(summary, /flows\/login\.spec\.ts/, "an unchanged spec is not part of the change the reviewer must focus on");
});

test("a comment-only change produces no change summary", () => {
  const commented = `// only a comment\ntest("x", async ({ page }) => { await page.goto("/a"); });`;
  const plain = `test("x", async ({ page }) => { await page.goto("/a"); });`;
  assert.equal(renderSpecChanges([{ file: "a.spec.ts", text: plain }], [{ file: "a.spec.ts", text: commented }]), "");
});

test("the change summary is bounded however large the rewrite", () => {
  const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const after = Array.from({ length: 500 }, (_, i) => `changed ${i}`).join("\n");
  const summary = renderSpecChanges([{ file: "a.spec.ts", text: before }], [{ file: "a.spec.ts", text: after }], 1_000);
  assert.ok(summary.length <= 1_040, `summary must stay near its cap, got ${summary.length}`);
  assert.match(summary, /truncated/);
});
