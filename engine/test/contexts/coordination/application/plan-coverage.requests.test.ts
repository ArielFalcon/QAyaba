/* A "not observable" drop is held to what the run's capture recorded of the candidate's pages: a page that made requests is observable, and the fact names them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCoverage, renderReplanRequest } from "@contexts/coordination/application/plan-coverage.ts";
import { DROP_BASIS, type PlanDrop } from "@contexts/coordination/application/lead-plan.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { pageCandidate } from "../../../support/use-case-candidate.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

const seeded = (route: string, files: string[], over: Partial<UseCaseCandidate> = {}): UseCaseCandidate =>
  pageCandidate(route, undefined, { seeds: files.map((file) => ({ file, symbol: "*" })), ...over });
const dropOf = (candidate: UseCaseCandidate, basis: PlanDrop["basis"]): PlanDrop => ({ candidate: candidate.id, basis, reason: "the lead says so" });

const STYLE_REQUEST = "GET https://maps.example/styles/v1/owner/theme-a";
const recording = (...requests: string[]) => ({ recordedRequests: (candidate: UseCaseCandidate) => (candidate.id === "uc-/map" ? requests : []) });

test("a no-observable-change drop is refused when the pages of the candidate made requests while the run captured them, and the fact names one", () => {
  const style = seeded("/map", ["src/map.css"]);
  const coverage = planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [style], recording(STYLE_REQUEST, "POST https://dev.example/api/orders (×2)"));
  assert.deepEqual([coverage.dropped.length, coverage.unresolved.map((c) => c.id)], [0, [style.id]]);
  const why = coverage.refused?.[0]?.why ?? "";
  assert.ok(why.includes(STYLE_REQUEST), why);
  assert.match(why, /2 request\(s\)/);
});

test("a drop whose changed code is executable and whose pages made requests is refused by both facts", () => {
  const code = seeded("/map", ["src/map.ts"]);
  const why = planCoverage({ flows: [], dropped: [dropOf(code, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [code], recording(STYLE_REQUEST)).refused?.[0]?.why ?? "";
  assert.ok(why.includes("src/map.ts") && why.includes(STYLE_REQUEST), why);
});

test("the fact names the first requests and counts the rest", () => {
  const style = seeded("/map", ["src/map.css"]);
  const many = Array.from({ length: 6 }, (_, i) => `GET https://dev.example/api/r${i}`);
  const why = planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [style], recording(...many)).refused?.[0]?.why ?? "";
  assert.ok(why.includes("https://dev.example/api/r0") && why.includes("https://dev.example/api/r2"), why);
  assert.equal(why.includes("https://dev.example/api/r3"), false, "only the first are named");
  assert.match(why, /and 3 more/);
});

test("the other bases, and candidates whose pages recorded no request, are judged as before", () => {
  const style = seeded("/map", ["src/map.css"], { existingSpecs: ["flows/map.spec.ts"] });
  const facts = recording(STYLE_REQUEST);
  assert.equal(planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.ALREADY_COVERED)] }, [style], facts).dropped.length, 1);
  assert.equal(planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.NEEDS_UNAVAILABLE_STATE)] }, [style], facts).dropped.length, 1);
  const quiet = seeded("/orders", ["src/orders.css"]);
  assert.equal(planCoverage({ flows: [], dropped: [dropOf(quiet, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [quiet], facts).dropped.length, 1);
  assert.equal(planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [style]).dropped.length, 1, "no facts given, the drop stands");
});

test("the re-plan request shows the lead the request that contradicts its drop", () => {
  const style = seeded("/map", ["src/map.css"]);
  const coverage = planCoverage({ flows: [], dropped: [dropOf(style, DROP_BASIS.NO_OBSERVABLE_CHANGE)] }, [style], recording(STYLE_REQUEST));
  const text = renderReplanRequest(new PatternRedactionAdapter(), coverage.unresolved, coverage.refused);
  assert.ok(text.includes(STYLE_REQUEST), text);
});
