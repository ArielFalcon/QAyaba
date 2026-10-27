/* Which candidates of the change a lead's plan covers, drops with a reason, or leaves unresolved; and how the admission set is chosen. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ADMISSION_CANDIDATES, admissionSetOf, assembleReplanRequest, planCoverage, renderReplanRequest } from "@contexts/coordination/application/plan-coverage.ts";
import { DROP_BASIS, type PlanDrop } from "@contexts/coordination/application/lead-plan.ts";
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
    { flows: [{ routes: ["/shops/madrid"], candidates: [] }, { routes: [], candidates: ["uc-/cart"] }], dropped: [{ candidate: "uc-/orders", basis: "no-observable-change", reason: "only a log line changed" }] },
    required,
  );
  assert.deepEqual(coverage.covered.map((c) => c.id), ["uc-/cart", "uc-/shops/:city"]);
  assert.deepEqual(coverage.dropped.map((d) => [d.candidate.id, d.reason]), [["uc-/orders", "no-observable-change: only a log line changed"]]);
  assert.deepEqual(coverage.unresolved.map((c) => c.id), ["uc-/login"]);
});

test("an operation reached through a page is covered by a flow that visits that page", () => {
  const { required } = admissionSetOf([operation("/api/orders", { reachability: "via-page", pages: ["/orders"] })]);
  assert.deepEqual(planCoverage({ flows: [{ routes: ["/orders"], candidates: [] }], dropped: [] }, required).unresolved, []);
});

test("an id the plan cites that no candidate has is ignored, and a candidate both covered and dropped is covered", () => {
  const { required } = admissionSetOf([pageCandidate("/cart")]);
  const coverage = planCoverage({ flows: [{ routes: [], candidates: ["uc-nope", "uc-/cart"] }], dropped: [{ candidate: "uc-/cart", basis: "needs-unavailable-state", reason: "r" }] }, required);
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

const seeded = (route: string, files: string[], over: Partial<UseCaseCandidate> = {}): UseCaseCandidate =>
  pageCandidate(route, undefined, { seeds: files.map((file) => ({ file, symbol: "*" })), ...over });
const dropOf = (candidate: UseCaseCandidate, basis: PlanDrop["basis"]): PlanDrop => ({ candidate: candidate.id, basis, reason: "the lead says so" });

test("a no-observable-change drop is refused when the candidate's changed files include executable code, whatever the stack, and stands for a style sheet", () => {
  for (const file of ["src/cart.ts", "web/Cart.jsx", "src/main/java/shop/CartController.java"]) {
    const candidate = seeded("/cart", [file, "src/cart.css"]);
    const coverage = planCoverage({ flows: [], dropped: [dropOf(candidate, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [candidate]);
    assert.deepEqual([coverage.dropped.length, coverage.unresolved.map((c) => c.id)], [0, [candidate.id]], file);
    assert.equal(coverage.refused?.[0]?.candidate.id, candidate.id, file);
  }
  const style = seeded("/cart", ["src/cart.css", "templates/cart.html"]);
  const coverage = planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [style]);
  assert.deepEqual([coverage.dropped.length, coverage.unresolved.length], [1, 0]);
  const testOnly = seeded("/cart", ["src/cart.test.ts"]);
  assert.equal(planCoverage({ flows: [], dropped: [dropOf(testOnly, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [testOnly]).dropped.length, 1, "a test file is not the change's own code");
});

test("an already-covered drop is refused when no spec of the suite is linked to the candidate, and a needs-unavailable-state drop stands", () => {
  const bare = seeded("/cart", ["src/cart.ts"]);
  const held = seeded("/orders", ["src/orders.ts"], { existingSpecs: ["flows/orders.spec.ts"] });
  const coverage = planCoverage({ flows: [], dropped: [dropOf(bare, DROP_BASIS.ALREADY_COVERED), dropOf(held, DROP_BASIS.ALREADY_COVERED)] }, [bare, held]);
  assert.deepEqual(coverage.dropped.map((d) => d.candidate.id), [held.id]);
  assert.deepEqual(coverage.unresolved.map((c) => c.id), [bare.id]);
  const unreachable = planCoverage({ flows: [], dropped: [dropOf(bare, DROP_BASIS.NEEDS_UNAVAILABLE_STATE)] }, [bare]);
  assert.equal(unreachable.dropped.length, 1);
});

test("the re-plan request says why a drop was refused", () => {
  const candidate = seeded("/cart", ["src/cart.ts"]);
  const coverage = planCoverage({ flows: [], dropped: [dropOf(candidate, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [candidate]);
  const text = renderReplanRequest(new PatternRedactionAdapter(), coverage.unresolved, coverage.refused);
  assert.ok(text.includes(candidate.id) && text.includes("src/cart.ts") && text.includes(DROP_BASIS.NO_OBSERVABLE_CHANGE));
});

test("a no-observable-change drop is refused when a shared seed is executable code, and stands when the shared seeds are only style", () => {
  const code = seeded("/cart", ["src/cart.css"], { sharedSeeds: [{ file: "src/shared/format.ts", symbol: "formatMoney", pages: 4 }] });
  const refused = planCoverage({ flows: [], dropped: [dropOf(code, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [code]);
  assert.deepEqual([refused.dropped.length, refused.unresolved.map((c) => c.id)], [0, [code.id]]);
  assert.match(refused.refused?.[0]?.why ?? "", /src\/shared\/format\.ts/);

  const style = seeded("/cart", ["src/cart.css"], { sharedSeeds: [{ file: "src/shared/theme.scss", symbol: "*", pages: 4 }] });
  assert.equal(planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [style]).dropped.length, 1);
});

test("shared seeds change neither who covers a candidate nor how an already-covered drop is judged", () => {
  const shared = [{ file: "src/shared/format.ts", symbol: "formatMoney", pages: 4 }];
  const held = seeded("/orders", ["src/orders.css"], { existingSpecs: ["flows/orders.spec.ts"], sharedSeeds: shared });
  const bare = seeded("/cart", ["src/cart.css"], { sharedSeeds: shared });
  const coverage = planCoverage({ flows: [{ routes: ["/cart"], candidates: [] }], dropped: [dropOf(held, DROP_BASIS.ALREADY_COVERED)] }, [held, bare]);
  assert.deepEqual([coverage.covered.map((c) => c.id), coverage.dropped.map((d) => d.candidate.id)], [[bare.id], [held.id]]);
});

test("the re-plan request is assembled from the registered sections, which report their sizes and hashes", () => {
  const assembled = assembleReplanRequest(new PatternRedactionAdapter(), [pageCandidate("/orders", ["src/orders.ts::list", "page /orders"])]);
  assert.deepEqual(Object.keys(assembled.sectionSizes), ["unresolved", "answer"]);
  assert.deepEqual(Object.keys(assembled.sectionHashes ?? {}), ["unresolved", "answer"]);
  assert.equal(assembled.text, renderReplanRequest(new PatternRedactionAdapter(), [pageCandidate("/orders", ["src/orders.ts::list", "page /orders"])]));
});
