/* gapReachOf() tells what the run already holds about where a changed file is reached: for the use cases the file seeds, the pages' data contradictions (and which are a defect of the run), the pages read as a confirmed empty state and the routes that were not available. Facts come from their own sources; nothing is derived here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapReachOf } from "@contexts/run-orchestration/application/run-flow/gap-reach.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

const home = pageCandidate("/home", undefined, { id: "uc-home", seeds: [{ file: "src/home.page.ts", symbol: "*" }] });
const cart = pageCandidate("/cart", undefined, { id: "uc-cart", seeds: [{ file: "src/cart.page.ts", symbol: "*" }] });

const contradiction = (route: string, key: string, site = "src/home.page.ts"): DataContradiction => ({
  route,
  key,
  operation: "GET https://api.dev/restaurants",
  items: 12,
  provider: "provider-undeclared",
  consumer: { callSite: `${site}:40`, callSites: 1, declaredType: "Restaurant[]", reads: [`${site}:44`], readCount: 1 },
});
const unavailable: RouteAvailabilityFact = { route: "/cart", outcome: { kind: "redirected", to: "/login", mechanism: "client" }, basis: { class: "change-introduced", via: "route-guard", at: "src/guard.ts::canActivate" } };

const facts = {
  candidates: [home, cart],
  contradictions: [contradiction("/home", "menuPrice"), contradiction("/cart", "total", "src/cart.page.ts")],
  defects: [{ fact: contradiction("/home", "menuPrice"), basis: "page" as const, via: ["/home"] }],
  emptyPages: ["/cart"],
  availability: [unavailable],
};

test("the facts of the pages a file's use cases hold are told, each from its own source, and a contradiction that is a defect of the run says so", () => {
  const lines = gapReachOf("src/home.page.ts", facts);

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\/home/);
  assert.match(lines[0]!, /"menuPrice"/);
  assert.match(lines[0]!, /defect of the run/);
  assert.equal(lines.some((line) => /\/cart|"total"/.test(line)), false, "the facts of another use case's pages are not this file's");
});

test("a page read as a confirmed empty state and a route the change made unavailable are told for the file that seeds their use case", () => {
  const lines = gapReachOf("src/cart.page.ts", facts);

  assert.equal(lines.some((line) => /confirmed empty state/.test(line) && /\/cart/.test(line)), true);
  assert.equal(lines.some((line) => /the browser ends on \/login/.test(line)), true);
  assert.equal(lines.some((line) => /"total"/.test(line) && !/defect of the run/.test(line)), true, "a contradiction the run did not establish as a defect is not called one");
});

test("a file no use case of the change is seeded by, or a run that holds no fact, tells nothing", () => {
  assert.deepEqual(gapReachOf("src/stray.ts", facts), []);
  assert.deepEqual(gapReachOf("src/home.page.ts", { candidates: [home], contradictions: [], defects: [], emptyPages: [], availability: [] }), []);
});
