import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLORE_FINDING_KIND, type ExploreFinding } from "@contexts/coordination/application/exploration.ts";
import { FINDING_VERIFICATION, verifyExplorationFindings, type ExplorationGround } from "@contexts/coordination/application/explore-verification.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const finding = (kind: ExploreFinding["kind"], ref: string, claim = "the page lists the cart items"): ExploreFinding => ({ kind, ref, claim, evidence: "i read it" });

const ground = (over: Partial<ExplorationGround> = {}): ExplorationGround => ({
  redaction: new PatternRedactionAdapter(),
  packReadsPage: (path) => path === "/cart",
  dataRoutes: [{ path: "/orders", resultCount: 4 }],
  browserReads: ["/profile"],
  graphHolds: (ref) => ref === "src/cart.ts#totalOf",
  ...over,
});

const verdictOf = (f: ExploreFinding, g: ExplorationGround = ground()): string => verifyExplorationFindings([f], g)[0]!.verification;

test("a page finding for a page the pack read is verified", () => {
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.PAGE, "/cart")), FINDING_VERIFICATION.VERIFIED);
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.PAGE, "/cart/?tab=items#top")), FINDING_VERIFICATION.VERIFIED, "the query, the fragment and a trailing slash name the same page");
});

test("a data route the pack read and a page the sidekick's own browser showed are verified", () => {
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.DATA_STATE, "/orders", "four orders are listed")), FINDING_VERIFICATION.VERIFIED);
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.PAGE, "/profile")), FINDING_VERIFICATION.VERIFIED);
});

test("a route only the lead's claim names is unverified", () => {
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.PAGE, "/admin")), FINDING_VERIFICATION.UNVERIFIED);
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.PAGE, "https://elsewhere.example/cart")), FINDING_VERIFICATION.UNVERIFIED, "an address that is not a site path names no page");
});

test("a symbol the graph does not hold is unverified and one it holds is verified", () => {
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.SYMBOL, "src/cart.ts#totalOf")), FINDING_VERIFICATION.VERIFIED);
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.SYMBOL, "src/cart.ts#ghost")), FINDING_VERIFICATION.UNVERIFIED);
});

test("an element finding has nothing the orchestrator can check and stays a claim", () => {
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.ELEMENT, "e12")), FINDING_VERIFICATION.UNVERIFIED);
});

test("a claim that a page with results is empty is contradicted by the pack, whose read stands", () => {
  const [verified] = verifyExplorationFindings([finding(EXPLORE_FINDING_KIND.DATA_STATE, "/orders", "the page shows no results")], ground());
  assert.equal(verified!.verification, FINDING_VERIFICATION.CONTRADICTED);
  assert.match(verified!.contradictedBy ?? "", /4 results on \/orders/);
});

test("an empty claim about a page the pack read no results on is not contradicted", () => {
  assert.equal(verdictOf(finding(EXPLORE_FINDING_KIND.DATA_STATE, "/cart", "the page shows no results")), FINDING_VERIFICATION.VERIFIED, "the pack read the page and holds no results for it, so nothing contradicts the claim");
});
