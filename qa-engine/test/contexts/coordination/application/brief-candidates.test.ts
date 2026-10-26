/* The use cases a flow's brief carries, how its sidekick is told about them, and how its claims are read back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefCandidatesFor, MAX_BRIEF_CANDIDATES } from "@contexts/coordination/application/brief-candidates.ts";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { renderSidekickBrief } from "@contexts/coordination/application/sidekick-prompt.ts";
import { readDelegationResult } from "@contexts/coordination/application/delegation-reading.ts";
import { MAX_HUNK_LINES } from "@contexts/coordination/domain/hunks-for.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { pageCandidate } from "../../../support/use-case-candidate.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

const redaction = new PatternRedactionAdapter();
const SECRET = `sk-ant-api03-${"a".repeat(40)}`;

const DIFF = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -3,2 +3,3 @@ export function total()",
  " keep 3",
  `+const key = "${SECRET}";`,
  " keep 5",
].join("\n");

const cart = (over: Partial<UseCaseCandidate> = {}): UseCaseCandidate =>
  pageCandidate("/cart", ["src/cart.ts::total", "page /cart"], { seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 10 } }], ...over });

test("a flow's candidates are the ones it cites, then the ones its routes name, at most four", () => {
  const all = Array.from({ length: 6 }, (_, i) => pageCandidate(`/p${i}`));
  const picked = briefCandidatesFor({ routes: ["/p4", "/p5", "/p0", "/p1", "/p2"], candidates: ["uc-/p3"] }, all, { diffs: [] });
  assert.equal(picked.length, MAX_BRIEF_CANDIDATES);
  assert.deepEqual(picked.map((c) => c.id), ["uc-/p3", "uc-/p0", "uc-/p1", "uc-/p2"]);
  assert.deepEqual(briefCandidatesFor({ routes: ["/nowhere"], candidates: ["uc-unknown"] }, all, { diffs: [] }), []);
});

test("the brief's candidate carries its symbols, a hunk of the changed symbol and the sources of the expected behavior, ending with the diff", () => {
  const [candidate] = briefCandidatesFor({ routes: ["/cart"], candidates: [] }, [cart()], { diffs: [DIFF], subject: "feat(cart): show the total" });
  assert.equal(candidate!.id, "uc-/cart");
  assert.deepEqual(candidate!.symbols, ["total (src/cart.ts:1-10)"]);
  assert.equal(candidate!.hunks.length, 1);
  assert.ok(candidate!.hunks[0]!.includes("+const key"));
  assert.deepEqual(candidate!.expectedFrom.map((s) => s.kind), ["commit-message", "diff"]);
});

test("an operation with a declared contract lists the contract first, and the diff is always last", () => {
  const operation = cart({ id: "uc-op", entry: { kind: "operation", repo: "org/api", verb: "GET", path: "/api/cart", operationId: "getCart" }, basis: "contract", reachability: "via-page", pages: ["/cart"] });
  const [candidate] = briefCandidatesFor({ routes: ["/cart"], candidates: ["uc-op"] }, [operation], { diffs: [] });
  assert.deepEqual(candidate!.expectedFrom.map((s) => [s.kind, s.kind === "contract" ? s.ref : undefined]), [["contract", "GET /api/cart"], ["diff", undefined]]);
});

test("a hunk in the brief is bounded, and a secret in it never reaches the sidekick's prompt", () => {
  const long = ["diff --git a/src/cart.ts b/src/cart.ts", "--- a/src/cart.ts", "+++ b/src/cart.ts", `@@ -1,0 +1,${MAX_HUNK_LINES * 2} @@`, ...Array.from({ length: MAX_HUNK_LINES * 2 }, (_, i) => `+line ${i}`)].join("\n");
  const [bounded] = briefCandidatesFor({ routes: ["/cart"], candidates: [] }, [cart()], { diffs: [long] });
  assert.ok(bounded!.hunks[0]!.split("\n").length <= MAX_HUNK_LINES + 3);
  const brief = createDelegationBrief({ redaction, delegationId: "d", runId: "r", objective: "o", task: "t", scope: { readablePaths: [], writablePaths: [], allowedCommands: [] }, candidates: briefCandidatesFor({ routes: ["/cart"], candidates: [] }, [cart()], { diffs: [DIFF] }) });
  assert.ok(!JSON.stringify(brief).includes("sk-ant-api03-aaaa"));
  assert.ok(!renderSidekickBrief(redaction, brief).text.includes("sk-ant-api03-aaaa"));
});

const briefWith = (candidates?: ReturnType<typeof briefCandidatesFor>) =>
  createDelegationBrief({ redaction, delegationId: "d", runId: "r", objective: "o", task: "t", scope: { readablePaths: [], writablePaths: [], allowedCommands: [] }, ...(candidates ? { candidates } : {}) });

test("the sidekick's prompt names each candidate, where the expected behavior comes from, and the claim it must report", () => {
  const brief = briefWith(briefCandidatesFor({ routes: ["/cart"], candidates: [] }, [cart()], { diffs: [DIFF], subject: "feat(cart): show the total" }));
  const { text, sectionSizes } = renderSidekickBrief(redaction, brief);
  assert.ok(sectionSizes.change! > 0);
  assert.ok(text.includes("uc-/cart") && text.includes("total (src/cart.ts:1-10)") && text.includes("commit-message"));
  assert.match(text, /"candidates":\[\{"id":"uc-\.\.\.","status":"covered"\|"not-covered"\|"blocked"/);
  assert.match(text, /never from what the page shows/);
});

test("a brief with no candidates renders no Change section and no candidates claim", () => {
  const { text, sectionSizes } = renderSidekickBrief(redaction, briefWith());
  assert.equal(sectionSizes.change, undefined);
  assert.ok(!text.includes('"candidates"') && !text.includes("Change this flow"));
});

test("a sidekick's claims are kept for the ids its brief carried, once each, and a claim about any other is dropped", () => {
  const brief = briefWith(briefCandidatesFor({ routes: ["/cart"], candidates: [] }, [cart()], { diffs: [] }));
  const answer = JSON.stringify({
    delegationId: "d", runId: "r", status: "completed", summary: "s", filesChanged: [], evidence: [], validation: [], acceptance: [], recommendation: "accept",
    candidates: [{ id: "uc-/cart", status: "covered", spec: `total ${SECRET}` }, { id: "uc-/cart", status: "blocked" }, { id: "uc-other", status: "covered" }, { id: "uc-/cart2", status: "bogus" }],
  });
  const result = readDelegationResult(answer, brief, redaction);
  assert.equal(result.candidates?.length, 1);
  assert.equal(result.candidates?.[0]?.status, "covered");
  assert.ok(!result.candidates?.[0]?.spec?.includes("sk-ant-api03-aaaa"));
  const without = readDelegationResult(answer, briefWith(), redaction);
  assert.equal(without.candidates, undefined);
});
