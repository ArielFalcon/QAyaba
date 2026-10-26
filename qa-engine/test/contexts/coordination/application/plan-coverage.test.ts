/* Which candidates of the change a lead's plan covers, drops with a reason, or leaves unresolved; and how the admission set is chosen. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ADMISSION_CANDIDATES, admissionSetOf, planCoverage, renderReplanRequest } from "@contexts/coordination/application/plan-coverage.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { pageCandidate } from "../../../support/use-case-candidate.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

const operation = (path: string, over: Partial<UseCaseCandidate> = {}): UseCaseCandidate =>
  ({ ...pageCandidate(path), id: `uc-op${path}`, entry: { kind: "operation", repo: "org/api", verb: "GET", path }, reachability: "backend-only", ...over });

test("the admission set holds the direct candidates a browser reaches, in the order given, and counts the rest", () => {
  const set = admissionSetOf([
    pageCandidate("/a"),
    pageCandidate("/deep", ["x"], { tier: "indirect" }),
    operation("/api/solo"),
    operation("/api/shared", { reachability: "via-page", pages: ["/b"] }),
    pageCandidate("/far", ["x"], { tier: "cross-repo" }),
  ]);
  assert.deepEqual(set.required.map((c) => c.id), ["uc-/a", "uc-op/api/shared"]);
  assert.equal(set.others, 3);
});

test("the admission set is bounded and the candidates past the bound count as others", () => {
  const many = Array.from({ length: MAX_ADMISSION_CANDIDATES + 3 }, (_, i) => pageCandidate(`/p${i}`));
  const set = admissionSetOf(many);
  assert.equal(set.required.length, MAX_ADMISSION_CANDIDATES);
  assert.equal(set.others, 3);
  assert.deepEqual(admissionSetOf(undefined), { required: [], others: 0 });
});

test("a candidate is covered when a flow cites its id or visits one of its pages, dropped when listed with a reason, unresolved otherwise", () => {
  const { required } = admissionSetOf([pageCandidate("/cart"), pageCandidate("/shops/:city"), pageCandidate("/orders"), pageCandidate("/login")]);
  const coverage = planCoverage(
    { flows: [{ routes: ["/shops/madrid"], candidates: [] }, { routes: [], candidates: ["uc-/cart"] }], dropped: [{ candidate: "uc-/orders", reason: "only a log line changed" }] },
    required,
  );
  assert.deepEqual(coverage.covered.map((c) => c.id), ["uc-/cart", "uc-/shops/:city"]);
  assert.deepEqual(coverage.dropped.map((d) => [d.candidate.id, d.reason]), [["uc-/orders", "only a log line changed"]]);
  assert.deepEqual(coverage.unresolved.map((c) => c.id), ["uc-/login"]);
});

test("an operation reached through a page is covered by a flow that visits that page", () => {
  const { required } = admissionSetOf([operation("/api/orders", { reachability: "via-page", pages: ["/orders"] })]);
  assert.deepEqual(planCoverage({ flows: [{ routes: ["/orders"], candidates: [] }], dropped: [] }, required).unresolved, []);
});

test("an id the plan cites that no candidate has is ignored, and a candidate both covered and dropped is covered", () => {
  const { required } = admissionSetOf([pageCandidate("/cart")]);
  const coverage = planCoverage({ flows: [{ routes: [], candidates: ["uc-nope", "uc-/cart"] }], dropped: [{ candidate: "uc-/cart", reason: "r" }] }, required);
  assert.deepEqual([coverage.covered.length, coverage.dropped.length, coverage.unresolved.length], [1, 0, 0]);
});

test("a plan against an empty admission set resolves nothing", () => {
  assert.deepEqual(planCoverage({ flows: [], dropped: [] }, []), { covered: [], dropped: [], unresolved: [] });
});

test("the re-plan request names each unresolved candidate by id and redacts what it prints", () => {
  const secret = `sk-ant-api03-${"a".repeat(40)}`;
  const text = renderReplanRequest(new PatternRedactionAdapter(), [pageCandidate("/orders", [`src/${secret}.ts::x`, "page /orders"])]);
  assert.ok(text.includes("uc-/orders"));
  assert.ok(!text.includes("sk-ant-api03-aaaa"));
});
