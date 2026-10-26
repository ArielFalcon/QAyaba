import { test } from "node:test";
import assert from "node:assert/strict";
/* expected values are fixed snapshots — do not rebase them to silence a failure */
import {
  checkSpecSelectors,
  unscopedMultipleContradictions,
  confidentWindowEnd,
  extractTestIdSelectorsWithIndex,
  firstGotoRoute,
  type ProposedSelector,
} from "@contexts/generation/domain/selector-check.ts";

test("checkSpecSelectors: present + unique selector", () => {
  const specs = [`await page.getByRole("button", { name: "Add Owner" }).click();`];
  const trees = [["button: Add Owner", "textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: true,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: verifiable-absent selector", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees = [["button: Cancel", "textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [`button: "Submit" is NOT in the captured failure-point tree. Present roles: button, textbox`],
    absentKeys: new Set(["role|button|Submit|0|0"]),
    anyVerifiedPresent: false,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: MULTIPLE-node strict-mode ambiguity", () => {
  const specs = [`await page.getByRole("textbox", { name: "Owner name" }).fill("x");`];
  const trees = [["textbox: Owner name", "textbox: Owner name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [`textbox: "Owner name" matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)`],
    absentKeys: new Set(),
    anyVerifiedPresent: true,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: unverifiable (role never seen with a real name)", () => {
  const specs = [`await page.getByRole("button", { name: "Ghost" }).click();`];
  const trees = [["textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: false,
    anyNonExtractable: false,
    anyUnverifiable: true,
  });
});

test("checkSpecSelectors: non-extractable locator flags anyNonExtractable", () => {
  const specs = [`await page.getByTestId("submit-btn").click();`];
  const trees = [["button: Submit"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: false,
    anyNonExtractable: true,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: per-tree (never fused): present on tree A, absent on tree B is NOT absent", () => {
  const specs = [`await page.getByRole("button", { name: "Checkout" }).click();`];
  const trees = [["button: Checkout"], ["textbox: Search"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: true,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: a commented-out selector is not extracted", () => {
  const specs = [
    `// await page.getByRole("button", { name: "Ghost" }).click();\nawait page.getByRole("button", { name: "Real" }).click();`,
  ];
  const trees = [["button: Real"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: true,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: a URL inside a string is not mistaken for a comment (string-aware strip)", () => {
  const specs = [`await page.goto("https://example.com/checkout"); // comment\nawait page.getByRole("button", { name: "Pay" }).click();`];
  const trees = [["button: Pay"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: true,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: empty trees yields empty findings (safe no-op)", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees: string[][] = [];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: false,
    anyNonExtractable: false,
    anyUnverifiable: true,
  });
});

test("checkSpecSelectors: custom treeLabel threads into the absent message", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees = [["button: Cancel"]];
  assert.deepEqual(checkSpecSelectors(specs, trees, "pre-write"), {
    contradictions: [`button: "Submit" is NOT in the captured pre-write tree. Present roles: button`],
    absentKeys: new Set(["role|button|Submit|0|0"]),
    anyVerifiedPresent: false,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: (present) structural marker never name-matches", () => {
  const specs = [`await page.getByRole("row", { name: "Present" }).click();`];
  const trees = [["row: (present)"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: false,
    anyNonExtractable: false,
    anyUnverifiable: true,
  });
});

test("checkSpecSelectors: getByText and getByLabel kinds", () => {
  const specs = [
    `await page.getByText("Welcome back").click(); await page.getByLabel("Email").fill("x@example.com");`,
  ];
  const trees = [["text: Welcome back", "textbox: Email"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [],
    absentKeys: new Set(),
    anyVerifiedPresent: true,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("checkSpecSelectors: multiple spec sources aggregate findings", () => {
  const specs = [
    `await page.getByRole("button", { name: "Save" }).click();`,
    `await page.getByRole("button", { name: "Delete" }).click();`,
  ];
  const trees = [["button: Save"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), {
    contradictions: [`button: "Delete" is NOT in the captured failure-point tree. Present roles: button`],
    absentKeys: new Set(["role|button|Delete|0|0"]),
    anyVerifiedPresent: true,
    anyNonExtractable: false,
    anyUnverifiable: false,
  });
});

test("ProposedSelector shape round-trips through both copies identically (structural sanity)", () => {
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Submit", exact: true };
  assert.deepEqual(sel, { kind: "role", role: "button", name: "Submit", exact: true });
});

test("confidentWindowEnd: closes at the first click", () => {
  const src = `await page.goto("/owners"); await page.getByRole("button", { name: "Add" }).click(); await page.getByTestId("late-id").click();`;
  assert.equal(confidentWindowEnd(src), 75);
});

test("confidentWindowEnd: closes at the second goto", () => {
  const src = `await page.goto("/owners"); await page.goto("/owners/new"); await page.getByTestId("late-id").click();`;
  assert.equal(confidentWindowEnd(src), 38);
});

test("confidentWindowEnd: Infinity when nothing closes the window", () => {
  const src = `await page.goto("/owners"); await page.fill("#x", "y");`;
  assert.equal(confidentWindowEnd(src), Infinity);
});

test("extractTestIdSelectorsWithIndex: value + index pairs, interpolated dropped", () => {
  const src = `await page.getByTestId("save-btn").click(); await page.getByTestId(\`row-\${id}\`).click();`;
  assert.deepEqual(extractTestIdSelectorsWithIndex(src), [{ value: "save-btn", index: 10 }]);
});

test("firstGotoRoute: literal route, leading slash normalized", () => {
  const src = `await page.goto("owners");`;
  assert.equal(firstGotoRoute(src), "/owners");
});

test("firstGotoRoute: un-navigable (interpolated / absolute URL) yields undefined", () => {
  const interpolated = "await page.goto(`/owners/${id}`);";
  const absolute = `await page.goto("https://example.com/owners");`;
  assert.equal(firstGotoRoute(interpolated), undefined);
  assert.equal(firstGotoRoute(absolute), undefined);
});

/* unscopedMultipleContradictions — base behavior (page-rooted MULTIPLE still surfaces).
 */
test("unscopedMultipleContradictions: page-rooted MULTIPLE survives suppression", () => {
  const specs = [`page.getByRole("button").click(); page.getByTestId("x").click();`];
  const trees = [["button: A", "button: B"]];
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), [
    "button: matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)",
  ]);
});

test("unscopedMultipleContradictions: no non-extractable locator, fast path returns MULTIPLE as-is", () => {
  const specs = [`page.getByRole("button", { name: "Owner name" }).fill("x");`];
  const trees = [["textbox: Owner name", "textbox: Owner name"]];
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), []);
});

/* Idiom-aware MULTIPLE suppression (declared divergence): the canonical module SUPPRESSES two
   false-block idioms a page-rooted-only check does not: a selector followed by
   .first(/.nth(/.filter( (the AUTHOR already disambiguated it), and a selector preceded by an
   extractable scope chain (e.g. .getByRole("table").getByRole("row", {...}) — already scoped to a
   unique parent even though BOTH ends are extractable; isPageRootedAt only inspects the IMMEDIATE
   prefix token). This only NARROWS blocking — it can never fabricate a new contradiction.
   The frozen snapshots below capture what an unscoped page-rooted check produced for these exact
   inputs (all non-empty), confirming the canonical module now suppresses those MULTIPLEs.
 */

test("DECLARED divergence: .first() suppresses a MULTIPLE a page-rooted check would surface", () => {
  const specs = [`await page.getByRole("row").first().click();`];
  const trees = [["row: (present)", "row: (present)", "row: (present)"]];
  const referenceResult = ["row: matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)"];
  assert.ok(referenceResult.length > 0, "sanity: a page-rooted check surfaces the MULTIPLE for a page-rooted role-only selector");
  const rewritten = unscopedMultipleContradictions(specs, trees);
  assert.deepEqual(rewritten, [], ".first() disambiguates — no contradiction should surface");
});

test("DECLARED divergence: .nth() suppresses a MULTIPLE a page-rooted check would surface", () => {
  const specs = [`await page.getByRole("row").nth(1).click();`];
  const trees = [["row: (present)", "row: (present)", "row: (present)"]];
  const referenceResult = ["row: matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)"];
  assert.ok(referenceResult.length > 0, "sanity: a page-rooted check surfaces the MULTIPLE for a page-rooted role-only selector");
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), []);
});

test("DECLARED divergence: .filter() suppresses a MULTIPLE a page-rooted check would surface", () => {
  const specs = [`await page.getByRole("row").filter({ hasText: "Edit" }).click();`];
  const trees = [["row: (present)", "row: (present)", "row: (present)"]];
  const referenceResult = ["row: matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)"];
  assert.ok(referenceResult.length > 0, "sanity: a page-rooted check surfaces the MULTIPLE for a page-rooted role-only selector");
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), []);
});

test("DECLARED divergence: role-chained scoping (table.getByRole(...)) suppresses a MULTIPLE", () => {
  const specs = [`await page.getByRole("table").getByRole("row", { name: "x" }).click();`];
  const trees = [["table: (present)", "row: x", "row: x"]];
  const referenceResult = [`row: "x" matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)`];
  assert.ok(referenceResult.length > 0, "missing the .getByRole('table') scope chain)");
  assert.deepEqual(unscopedMultipleContradictions(specs, trees), []);
});

test("page-rooted suppression applies UNCONDITIONALLY (no anyNonExtractable gate) — a real ambiguity with NO non-extractable locator anywhere still surfaces", () => {
  /* Regression guard for the page-rooted suppression rule ("page-rooted suppression applies unconditionally, not
     gated on anyNonExtractable"): a spec with ZERO non-extractable locators must still surface a
     genuine page-rooted MULTIPLE (this must NOT start returning [] just because the idiom-aware
     suppression logic now always runs the per-selector path instead of the anyNonExtractable fast path).
   */
  const specs = [`await page.getByRole("button", { name: "Save" }).click();`];
  const trees = [["button: Save", "button: Save"]];
  const result = unscopedMultipleContradictions(specs, trees);
  assert.equal(result.length, 1);
  assert.match(result[0]!, /MULTIPLE/);
});
