import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDomRouteBlocks, precheckSpecsAgainstDom } from "@contexts/generation/domain/deterministic-review-precheck.ts";

/*
 * The live run's R4 shape: the spec asserts the empty state ("0 resultados") while the captured
 * page shows 11 restaurants and the end-of-list button. The reviewer rejected it (correctly) with a
 * [false-positive] correction; the deterministic pre-check must reach the same verdict from the same
 * evidence, without a model.
 */
const R4_DOM = [
  "route /restaurantes:",
  "  heading: Restaurantes",
  "  text: 11 restaurantes",
  "  textbox: Buscar",
  "  button: Buscar",
  "  button: Inicio",
  "  button: Fin de la lista",
  "  test-ids on this route: restaurant-card, end-of-list",
].join("\n");

const R4_SPEC = `
import { test, expect } from "../../run-orchestration/fixtures";

test("the empty state is shown", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByText("0 resultados")).toBeVisible();
});
`;

const LEGIT_SPEC = `
import { test, expect } from "../../run-orchestration/fixtures";

test("the list and its first card are shown", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByText("11 restaurantes")).toBeVisible();
  await expect(page.getByTestId("restaurant-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Fin de la lista" })).toBeVisible();
});
`;

test("R4 regression: a spec asserting an empty state the captured page contradicts is rejected as a blocking false positive", () => {
  const findings = precheckSpecsAgainstDom({
    specs: [{ file: "flows/restaurantes.spec.ts", text: R4_SPEC }],
    domSnapshot: R4_DOM,
  });

  assert.equal(findings.length, 1, "one clear contradiction: the asserted literal is not on the page");
  assert.equal(findings[0]!.file, "flows/restaurantes.spec.ts");
  assert.match(findings[0]!.correction, /^\[false-positive\]/);
  assert.match(findings[0]!.correction, /0 resultados/);
  assert.match(findings[0]!.correction, /\/restaurantes/);
});

test("a legitimate spec is not rejected: its asserted text, test id and role are all on the captured page", () => {
  const findings = precheckSpecsAgainstDom({
    specs: [{ file: "flows/restaurantes.spec.ts", text: LEGIT_SPEC }],
    domSnapshot: R4_DOM,
  });

  assert.deepEqual(findings, []);
});

test("an empty-state assertion made after a user action is not checked: the captured page is the page as loaded", () => {
  const filtered = `
test("filtering shows the empty state", async ({ page }) => {
  await page.goto("/restaurantes");
  await page.getByRole("textbox", { name: "Buscar" }).fill("zzzz");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByText("0 resultados")).toBeVisible();
});
`;
  const findings = precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: filtered }], domSnapshot: R4_DOM });

  assert.deepEqual(findings, [], "the assertion runs on a page state the capture never saw; fail open");
});

test("a test id the captured route does not list is a clear contradiction, and blocking", () => {
  const spec = `
test("opens the ghost card", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByTestId("ghost-card")).toBeVisible();
});
`;
  const findings = precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM });

  assert.equal(findings.length, 1);
  assert.match(findings[0]!.correction, /^\[false-positive\].*ghost-card/s);
});

test("a named role the captured route does not expose is a clear contradiction", () => {
  const spec = `
test("deletes a restaurant", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByRole("button", { name: "Borrar restaurante" })).toBeVisible();
});
`;
  const findings = precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM });

  assert.equal(findings.length, 1);
  assert.match(findings[0]!.correction, /Borrar restaurante/);
});

test("a locator used only to act is not an assertion: a click target is not judged against the captured page", () => {
  const spec = `
test("opens a ghost", async ({ page }) => {
  await page.goto("/restaurantes");
  await page.getByTestId("ghost-card").click();
});
`;
  assert.deepEqual(precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM }), []);
});

test("a literal with no count is not judged absent: a transient loading state is not what the settled capture shows", () => {
  const spec = `
test("shows a loading state", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByText("Cargando restaurantes")).toBeVisible();
});
`;
  assert.deepEqual(precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM }), []);
});

test("an assertion of absence agrees with the page: a negated or count-zero assertion is never a contradiction", () => {
  const spec = `
test("the empty state is not shown", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByText("0 resultados")).not.toBeVisible();
  await expect(page.getByTestId("ghost-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Borrar restaurante" })).toBeHidden();
});
`;
  assert.deepEqual(precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM }), []);
});

test("a positive count on an absent element is still a contradiction", () => {
  const spec = `
test("two ghost cards", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByTestId("ghost-card")).toHaveCount(2);
});
`;
  const findings = precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.correction, /ghost-card/);
});

test("a test id asserted after a click is not checked", () => {
  const spec = `
test("opens the dialog", async ({ page }) => {
  await page.goto("/restaurantes");
  await page.getByRole("button", { name: "Fin de la lista" }).click();
  await expect(page.getByTestId("ghost-card")).toBeVisible();
});
`;
  assert.deepEqual(precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM }), []);
});

test("no DOM, no finding", () => {
  assert.deepEqual(precheckSpecsAgainstDom({ specs: [{ file: "a.spec.ts", text: R4_SPEC }] }), []);
  assert.deepEqual(precheckSpecsAgainstDom({ specs: [{ file: "a.spec.ts", text: R4_SPEC }], domSnapshot: "" }), []);
});

test("a degraded, truncated or absent route is not evidence of absence", () => {
  const redirected = "route /restaurantes: (redirected to /login)\n  heading: Iniciar sesión";
  const truncated = [
    "route /restaurantes:",
    "  heading: Restaurantes",
    "  … (5 more non-table elements omitted)",
  ].join("\n");
  const otherRoute = "route /owners:\n  heading: Owners\n  button: Add Owner";

  for (const domSnapshot of [redirected, truncated, otherRoute]) {
    assert.deepEqual(
      precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: R4_SPEC }], domSnapshot }),
      [],
      `must fail open on: ${domSnapshot.split("\n")[0]}`,
    );
  }
});

test("a regex or interpolated literal is never compared", () => {
  const spec = `
test("dynamic", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByText(/0 resultados/)).toBeVisible();
  await expect(page.getByText(\`\${count} resultados\`)).toBeVisible();
});
`;
  assert.deepEqual(precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM }), []);
});

test("the route pack parser reads addresses, templates and the test-id inventory without losing a template's colons", () => {
  const blocks = parseDomRouteBlocks([
    "route /restaurantes:",
    "  heading: Restaurantes",
    "  button: Fin de la lista  -> [data-testid=end-of-list]",
    "  test-ids on this route: end-of-list (×2)",
    "route /shops/spain/madrid (instance of /shops/:province/:city):",
    "  heading: Madrid",
  ].join("\n"));

  assert.deepEqual(blocks.map((b) => b.route), ["/restaurantes", "/shops/spain/madrid"]);
  assert.deepEqual([...blocks[0]!.testIds ?? []], ["end-of-list"]);
  assert.deepEqual(blocks[0]!.lines, ["heading: Restaurantes", "button: Fin de la lista"]);
  assert.equal(blocks[1]!.testIds, undefined, "a route without an inventory is not evidence about test ids");
  assert.equal(blocks[1]!.complete, true);
});

test("findings are capped so one bad capture cannot flood the correction list", () => {
  const spec = `
test("many ghosts", async ({ page }) => {
  await page.goto("/restaurantes");
  await expect(page.getByText("0 resultados")).toBeVisible();
  await expect(page.getByText("0 restaurantes")).toBeVisible();
  await expect(page.getByText("0 reservas")).toBeVisible();
  await expect(page.getByText("0 opiniones")).toBeVisible();
  await expect(page.getByText("0 favoritos")).toBeVisible();
  await expect(page.getByText("0 pedidos")).toBeVisible();
  await expect(page.getByText("0 facturas")).toBeVisible();
});
`;
  const findings = precheckSpecsAgainstDom({ specs: [{ file: "flows/restaurantes.spec.ts", text: spec }], domSnapshot: R4_DOM });
  assert.equal(findings.length, 6);
});

/* The live run's shape: a spec set a mobile viewport the capture does not use, asserted a link the capture's page did not expose, and passed on DEV. */
/* The capture's page lists links, just not this one (the desktop header it saw is not the mobile menu the spec opened). */
const LINK_DOM = `${R4_DOM}\n  link: Restaurantes\n  link: Contacto`;

const LINK_BEFORE_CLICK_SPEC = `
test("the home link is shown", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/restaurantes");
  await expect(page.getByRole("link", { name: "Mapa" })).toBeVisible();
  await page.getByRole("button", { name: "Buscar" }).click();
});
`;

test("a link asserted before the first click and absent from the captured page is not checked when its spec file passed on DEV", () => {
  const spec = { file: "flows/home.spec.ts", text: LINK_BEFORE_CLICK_SPEC };

  const unproven = precheckSpecsAgainstDom({ specs: [spec], domSnapshot: LINK_DOM });
  const proven = precheckSpecsAgainstDom({ specs: [spec], domSnapshot: LINK_DOM, provenGreenFiles: new Set(["flows/home.spec.ts"]) });

  assert.equal(unproven.length, 1, "without a proof the contradiction is reported as before");
  assert.match(unproven[0]!.correction, /link "Mapa"/);
  assert.deepEqual(proven, [], "a file that passed on DEV resolved its assertion there");
});

test("only the proven spec file is skipped: another spec with the same contradiction is still rejected", () => {
  const findings = precheckSpecsAgainstDom({
    specs: [
      { file: "flows/home.spec.ts", text: LINK_BEFORE_CLICK_SPEC },
      { file: "flows/other.spec.ts", text: LINK_BEFORE_CLICK_SPEC },
    ],
    domSnapshot: LINK_DOM,
    provenGreenFiles: new Set(["flows/home.spec.ts"]),
  });

  assert.deepEqual(findings.map((finding) => finding.file), ["flows/other.spec.ts"]);
});
