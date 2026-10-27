/* renderIssue/renderPrBody are pure; sanitize is applied once by the caller to the whole body. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIssue, renderPrBody } from "@contexts/workspace-and-publication/domain/render-publication.ts";
import type { QaCase } from "@kernel/qa-case.ts";

function failCase(overrides: Partial<QaCase> = {}): QaCase {
  return { name: "checkout flow", status: "fail", detail: "expect(locator).toBeVisible() failed\nTimeout 5000ms exceeded", ...overrides };
}

/* ── Scenario: Failing run renders a distilled Issue, not a log dump ────────────────────────────── */

test("renderIssue: a fail run with 3 failing cases shows the headline and capped failing cases with one-line causes", () => {
  const cases: QaCase[] = [
    failCase({ name: "checkout" }),
    failCase({ name: "login", detail: "Error: getByRole resolved to 0 elements" }),
    failCase({ name: "search", detail: "assert(results.length).toBeGreaterThan(0) failed" }),
  ];

  const body = renderIssue({ verdict: "fail", cases });

  assert.match(body, /3 of 3 check\(s\) failed against the live environment/);
  assert.match(body, /### Failing cases/);
  assert.match(body, /\*\*checkout\*\*/);
  /* oneLineCause prefers the FIRST line naming an error/assertion — "checkout"'s own detail has
     its assertion on line 1, so that (not the "Timeout" line 2) is the distilled cause shown.
   */
  assert.match(body, /expect\(locator\)\.toBeVisible\(\) failed/);
  assert.match(body, /Error: getByRole resolved to 0 elements/);
});

test("renderIssue: contains no raw execution-log text (no logs input exists to embed)", () => {
  const body = renderIssue({ verdict: "fail", cases: [failCase()] });
  /* renderIssue's own input shape (RenderIssueInput) carries no `logs` field at all — structural
     proof that a raw log dump cannot reach the body through this function.
   */
  assert.ok(!body.includes("stdout:"), "no raw log marker text should ever appear");
  assert.match(body, /Full trace \+ logs in the run artifacts/, "the footer points at the run artifacts instead of embedding logs");
});

test("renderIssue: caps failing cases at 50 and reports the omitted count", () => {
  const cases: QaCase[] = Array.from({ length: 55 }, (_, i) => failCase({ name: `case-${i}` }));
  const body = renderIssue({ verdict: "fail", cases });
  assert.match(body, /_…and 5 more failed case\(s\) omitted\._/);
});

test("renderIssue: a flaky verdict renders the quarantine section", () => {
  const cases: QaCase[] = [{ name: "checkout", status: "flaky" }];
  const body = renderIssue({ verdict: "flaky", cases });
  assert.match(body, /### Flaky \(quarantined\)/);
  assert.match(body, /checkout/);
  assert.match(body, /1 test\(s\) were unstable and were quarantined/);
});

test("renderIssue: an invalid verdict renders the static-gate headline", () => {
  const body = renderIssue({ verdict: "invalid", cases: [] });
  assert.match(body, /the generated tests could not be validated \(static gate\)/);
});

/* ── Existing engine-adjudication + reviewer-unavailable sections — KEPT ────────── */

test("renderIssue: renders an 'Engine adjudication' section when adjudication is present", () => {
  const body = renderIssue({
    verdict: "fail",
    cases: [failCase()],
    adjudication: { class: "app_defect", confidence: "high", reason: "backend returned a 5xx" },
  });
  assert.match(body, /Engine adjudication/);
  assert.match(body, /app_defect/);
  assert.match(body, /backend returned a 5xx/);
});

test("renderIssue: words a low-confidence adjudication as an engine guess (hint)", () => {
  const body = renderIssue({
    verdict: "fail",
    cases: [],
    adjudication: { class: "generated_test_defect", confidence: "low", reason: "ambiguous failure" },
  });
  assert.match(body, /Engine adjudication \(low confidence — treat as a hint\)/);
});

test("renderIssue: omits the adjudication section entirely when absent", () => {
  const body = renderIssue({ verdict: "fail", cases: [failCase()] });
  assert.ok(!body.includes("Engine adjudication"));
});

test("renderIssue: renders a 'Reviewer unavailable' section when reviewerNote is present", () => {
  const body = renderIssue({ verdict: "pass", cases: [], reviewerNote: "reviewer unavailable: timed out after 360000ms" });
  assert.match(body, /Reviewer unavailable/);
  assert.match(body, /timed out after 360000ms/);
});

test("renderIssue: omits the 'Reviewer unavailable' section entirely when reviewerNote is absent", () => {
  const body = renderIssue({ verdict: "fail", cases: [] });
  assert.ok(!body.includes("Reviewer unavailable"));
});

/* ── "What was tested" (Issue) ───────────────────────────────────────────────────────────────────── */

test("renderIssue: renders a 'What was tested' section when tested is present", () => {
  const body = renderIssue({
    verdict: "fail",
    cases: [failCase()],
    tested: [{ flow: "Checkout", objective: "user can pay with a saved card" }],
  });
  assert.match(body, /### What was tested/);
  assert.match(body, /\*\*Checkout\*\*/);
  assert.match(body, /user can pay with a saved card/);
});

/* ── Scenario (negative): absent tested metadata does not crash rendering ───────────────────────── */

test("renderIssue: a caller that omits tested completes without throwing and omits the section", () => {
  assert.doesNotThrow(() => renderIssue({ verdict: "fail", cases: [] }));
  const body = renderIssue({ verdict: "fail", cases: [] });
  assert.ok(!body.includes("What was tested"));
});

test("renderPrBody: a caller that omits tested completes without throwing and omits the 'Covers:' section", () => {
  assert.doesNotThrow(() => renderPrBody({ isCode: false }));
  const body = renderPrBody({ isCode: false });
  assert.ok(!body.includes("Covers:"));
  assert.match(body, /## What this PR adds/);
  assert.match(body, /\*\*Validation:\*\*/);
});

/* ── Scenario: Green run renders a PR body with coverage statement ──────────────────────────────── */

test("renderPrBody: a green run with tested metadata present renders 'What this PR adds', a matching 'Covers:' list, and the validation statement", () => {
  const body = renderPrBody({
    sha: "abc1234",
    isCode: false,
    tested: [{ flow: "Checkout", objective: "user can pay with a saved card" }, { flow: "Login", objective: "user can sign in" }],
  });

  assert.match(body, /## What this PR adds/);
  assert.match(body, /E2E tests generated\/updated by qayaba for `abc1234`/);
  assert.match(body, /\*\*Covers:\*\*/);
  assert.match(body, /\*\*Checkout\*\*/);
  assert.match(body, /\*\*Login\*\*/);
  assert.match(body, /\*\*Validation:\*\* harness green/);
});

test("renderPrBody: a code-target run renders the code-flavored wording", () => {
  const body = renderPrBody({ isCode: true, tested: [{ flow: "parseConfig", objective: "rejects malformed YAML" }] });
  assert.match(body, /Source-code tests generated\/updated by qayaba\./);
  assert.match(body, /\*\*Validation:\*\* the repo's own test suite passed \(exit code 0\)/);
});

test("renderPrBody: tested items missing flow or objective still render (partial metadata degrades gracefully)", () => {
  const body = renderPrBody({ isCode: false, tested: [{ flow: "Checkout" }, { objective: "no flow name" }] });
  assert.match(body, /\*\*Checkout\*\*/);
  assert.match(body, /- no flow name/);
});

/* ── Scenario: Continuation run shows provenance ─────────────────────────────────────────────────── */

test("renderPrBody: a run carrying parentRunId includes a continuation reference", () => {
  const body = renderPrBody({ isCode: false, parentRunId: "run-deadbeef" });
  assert.match(body, /Continuation of run-deadbeef/);
});

test("renderPrBody: omits the continuation reference entirely when parentRunId is absent", () => {
  const body = renderPrBody({ isCode: false });
  assert.ok(!body.includes("Continuation of"));
});

/* ── Scenario: A failing run's Issue says whether the failure is in the change's reach ─────────── */

test("renderIssue: the change-reach section states the reach, basis, entries and each case for in-reach, out-of-reach and unknown", () => {
  const cases = [failCase({ name: "a" })];
  const reasons: Array<[string, string]> = [["in-reach", "in the change's reach"], ["out-of-reach", "outside the change's reach"], ["unknown", "reach unknown"]];
  for (const [reach, words] of reasons) {
    const body = renderIssue({ verdict: "fail", cases, causal: { reach, basis: reach === "unknown" ? "none" : "request", via: reach === "unknown" ? [] : ["GET /orders/{id}"], reason: "why", cases: [{ name: "a", reach, basis: "request" }] } });
    assert.match(body, new RegExp(`Change reach\\n- Reach: ${words}\\n- Basis: ${reach === "unknown" ? "none" : "request"}`));
    assert.match(body, new RegExp(`  - a: ${words} \\(request\\)`));
    assert.equal(body.includes("- Via:"), reach !== "unknown");
  }
});

test("renderIssue: an Issue with no label renders exactly as before", () => {
  const body = renderIssue({ verdict: "fail", cases: [failCase()] });
  assert.ok(!body.includes("Change reach"));
  assert.equal(body, renderIssue({ verdict: "fail", cases: [failCase()], reviewerNote: "  " }));
});

test("renderIssue: the change-reach section lists at most the bounded number of cases and says how many it left out", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `case-${i}`, reach: "in-reach", basis: "flow" }));
  const body = renderIssue({ verdict: "fail", cases: [failCase()], causal: { reach: "in-reach", basis: "flow", via: [], reason: "r", cases: many } });
  assert.match(body, /…and 10 more case\(s\) omitted/);
});

test("the reviewer's missing cases are listed in a PR body and an Issue, and nothing of them when there are none", () => {
  const missingCases = ["[missing-case] the empty search result is not tested", "[missing-case] a rejected coupon is not tested"];
  const pr = renderPrBody({ isCode: false, missingCases });
  const issue = renderIssue({ verdict: "fail", cases: [{ name: "pays", status: "fail" }], missingCases });
  for (const text of missingCases) {
    assert.ok(pr.includes(text), `PR: ${text}`);
    assert.ok(issue.includes(text), `Issue: ${text}`);
  }
  assert.equal(renderPrBody({ isCode: false }), renderPrBody({ isCode: false, missingCases: [] }));
});

test("a PR body lists every unavailability the change introduced and every possible regression, and nothing for the other classes", () => {
  const routeAvailability = [
    { route: "/upload-menu/preview", outcome: { kind: "redirected" as const, to: "/home", mechanism: "client" as const }, basis: { class: "change-introduced" as const, via: "route-declaration" as const, at: "src/app/app.routes.ts:102" } },
    { route: "/upload-menu/confirm", outcome: { kind: "redirected" as const, to: "/home", mechanism: "client" as const }, basis: { class: "change-introduced" as const, via: "route-guard" as const, at: "src/guards/native.ts::nativeOnlyGuard" } },
    { route: "/orders", outcome: { kind: "http-error" as const, status: 500 }, basis: { class: "regression-candidate" as const, reach: "implements" as const, runtimeError: true as const } },
    { route: "/login", outcome: { kind: "redirected" as const, to: "/home", mechanism: "client" as const }, basis: { class: "pre-existing" as const, why: "session-consistent" as const } },
  ];
  const pr = renderPrBody({ isCode: false, routeAvailability });
  assert.match(pr, /Routes this change makes unavailable[^\n]*\n- `\/upload-menu\/preview` ends on \/home \(client-side\): its route table entry changed at src\/app\/app\.routes\.ts:102\n- `\/upload-menu\/confirm` ends on \/home \(client-side\): a changed symbol reaches its guard src\/guards\/native\.ts::nativeOnlyGuard/);
  assert.match(pr, /Possible regressions[^\n]*\n- `\/orders` ends on HTTP 500: the change reaches the page and it logged a runtime error/);
  assert.doesNotMatch(pr, /\/login/);
  assert.match(renderIssue({ verdict: "fail", cases: [failCase()], routeAvailability }), /Routes this change makes unavailable/);
  assert.equal(renderPrBody({ isCode: false }), renderPrBody({ isCode: false, routeAvailability: [routeAvailability[3]!] }));
});

/* ── Tests that fulfil a stated response: published apart, as tested against that response and not DEV ── */

test("a PR body and an Issue list the stubbed tests as tested against a stated response, not DEV, and any guard they broke", () => {
  const stubbedState = {
    tests: [
      { file: "flow/cuisines.spec.ts", name: "[stubbed: geo response without the cuisine field] disables every chip", response: "geo response without the cuisine field", routes: ["**/geo/**"] },
      { file: "flow/cuisines.spec.ts", name: "through a helper", routes: [] },
    ],
    violations: [{ file: "flow/cuisines.spec.ts", kind: "fulfil-without-get-guard", test: "through a helper" }],
  };
  const pr = renderPrBody({ isCode: false, stubbedState });
  assert.match(pr, /Tested against a stated response, not DEV[^\n]*\n- `flow\/cuisines\.spec\.ts` › .*disables every chip — geo response without the cuisine field \(`\*\*\/geo\/\*\*`\)/);
  assert.match(pr, /- `flow\/cuisines\.spec\.ts` › through a helper — a helper it calls could not be read, so it is counted as stubbed/);
  assert.match(pr, /Guards these tests broke[^\n]*\n- `flow\/cuisines\.spec\.ts`[^\n]*through a helper[^\n]*fulfil-without-get-guard/);
  assert.match(renderIssue({ verdict: "fail", cases: [failCase()], stubbedState }), /Tested against a stated response, not DEV/);
});

test("a body with no stubbed test says nothing about stubs, and a violation alone is still listed", () => {
  assert.equal(renderPrBody({ isCode: false }), renderPrBody({ isCode: false, stubbedState: { tests: [] } }));
  const pr = renderPrBody({ isCode: false, stubbedState: { tests: [], violations: [{ file: "a.spec.ts", kind: "har-replay" }] } });
  assert.doesNotMatch(pr, /Tested against a stated response/);
  assert.match(pr, /Guards these tests broke[^\n]*\n- `a\.spec\.ts`[^\n]*har-replay/);
});
