/* An acceptance criterion the sidekick reports unmet because DEV cannot be brought to the state it needs: the orchestrator records it as such only when its own facts back the claim; every other unmet keeps blocking. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { readDelegationResult } from "@contexts/coordination/application/delegation-reading.ts";
import type { DevStateGround } from "@contexts/coordination/application/explore-verification.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const CRITERIA = ["available cuisines toggle the filter", "the filter lists every cuisine"];
const brief = createDelegationBrief({
  redaction, delegationId: "run-1-flow-cuisine", runId: "run-1", objective: "cuisine filter", task: "author the flow",
  scope: { readablePaths: [], writablePaths: ["e2e/flows/cuisine.spec.ts"], allowedCommands: [] },
  acceptanceCriteria: CRITERIA,
});

const SUMMARY = "the spec passes run_spec; every cuisine chip is disabled on DEV";
const answer = (acceptance: unknown): string =>
  JSON.stringify({
    delegationId: brief.delegationId, runId: brief.runId, status: "completed-with-concerns", summary: SUMMARY,
    filesChanged: [{ path: "e2e/flows/cuisine.spec.ts" }], concerns: ["all cuisines are aria-disabled on DEV"], unresolvedQuestions: [],
    recommendation: "review", acceptance,
  });
const unmetOnDev = (criterion: number, pages: unknown = ["/search"]) => ({ criterion, status: "unmet", cause: "dev-state", pages, note: "every chip is disabled" });
const met = (criterion: number) => ({ criterion, status: "met" });
const ground = (over: Partial<DevStateGround> = {}): DevStateGround => ({ flowReads: ["/search"], emptyReads: [], dataRoutes: [], ...over });

test("an unmet the sidekick attributes to DEV's state, on a page its own session read, is recorded with the fact that backs it instead of blocking", () => {
  const result = readDelegationResult(answer([unmetOnDev(1), met(2)]), brief, redaction, ground());
  assert.equal(result.status, "completed-with-concerns");
  assert.equal(result.recommendation, "review");
  assert.equal(result.summary, SUMMARY, "the sidekick's honest report reaches the lead, not a pushback verdict");
  assert.equal(result.unmetByDevState?.length, 1);
  assert.equal(result.unmetByDevState?.[0]?.criterion, 1);
  assert.deepEqual(result.unmetByDevState?.[0]?.pages, ["/search"]);
  assert.match(result.unmetByDevState?.[0]?.backing ?? "", /\/search/);
  assert.ok(result.concerns.some((c) => c.startsWith("acceptance-unmet-dev-state: ") && c.includes(CRITERIA[0]!)));
  assert.ok(!result.concerns.some((c) => c.startsWith("acceptance-contradiction")));
});

test("a page its own run_spec call read empty backs the claim as well as a page its browser session read", () => {
  const result = readDelegationResult(answer([unmetOnDev(1, ["/home"]), met(2)]), brief, redaction, ground({ flowReads: [], emptyReads: ["/home"] }));
  assert.equal(result.status, "completed-with-concerns");
  assert.equal(result.unmetByDevState?.[0]?.criterion, 1);
});

test("an unmet whose pages the orchestrator never saw the sidekick read keeps blocking", () => {
  const result = readDelegationResult(answer([unmetOnDev(1, ["/map"]), met(2)]), brief, redaction, ground());
  assert.equal(result.status, "blocked");
  assert.equal(result.recommendation, "escalate");
  assert.equal(result.unmetByDevState, undefined);
  assert.match(result.summary, /acceptance-contradiction/);
});

test("an unmet read with no facts of the run to back it keeps blocking", () => {
  const result = readDelegationResult(answer([unmetOnDev(1), met(2)]), brief, redaction);
  assert.equal(result.status, "blocked");
  assert.equal(result.unmetByDevState, undefined);
});

test("prose about DEV's state without the typed cause does not back an unmet", () => {
  const result = readDelegationResult(answer([{ criterion: 1, status: "unmet", note: "DEV has no enabled cuisine on /search" }, met(2)]), brief, redaction, ground());
  assert.equal(result.status, "blocked");
});

test("a DEV-state cause with no page, or with a path outside a page, backs nothing", () => {
  for (const pages of [[], null, [""], ["not a path"], [42]]) {
    const result = readDelegationResult(answer([unmetOnDev(1, pages), met(2)]), brief, redaction, ground({ flowReads: ["/search", "not a path"] }));
    assert.equal(result.status, "blocked", JSON.stringify(pages));
  }
});

test("an empty read the Context Pack contradicts does not back the claim: the pack read results on that page", () => {
  const result = readDelegationResult(
    answer([unmetOnDev(1), met(2)]), brief, redaction,
    ground({ emptyReads: ["/search"], dataRoutes: [{ path: "/search", resultCount: 12 }] }),
  );
  assert.equal(result.status, "blocked");
});

test("only the unmet the facts back is recorded; one they do not back still blocks and is the only one named", () => {
  const result = readDelegationResult(answer([unmetOnDev(1), unmetOnDev(2, ["/map"])]), brief, redaction, ground());
  assert.equal(result.status, "blocked");
  const contradictions = result.concerns.filter((c) => c.startsWith("acceptance-contradiction"));
  assert.equal(contradictions.length, 1);
  assert.match(contradictions[0]!, new RegExp(CRITERIA[1]!));
  assert.ok(!contradictions.some((c) => c.includes(CRITERIA[0]!)), "the criterion the facts back is not a contradiction");
});

test("an unmet with no attributed cause keeps blocking whatever the facts hold", () => {
  const result = readDelegationResult(answer([{ criterion: 1, status: "unmet", note: "my selector is wrong" }, met(2)]), brief, redaction, ground());
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /acceptance-contradiction/);
});

test("a DEV-state cause on a criterion reported met or unverified changes nothing", () => {
  const result = readDelegationResult(answer([{ criterion: 1, status: "met", cause: "dev-state", pages: ["/search"] }, { criterion: 2, status: "unverified", cause: "dev-state", pages: ["/search"] }]), brief, redaction, ground());
  assert.equal(result.status, "completed-with-concerns");
  assert.equal(result.unmetByDevState, undefined);
  assert.deepEqual(result.acceptance.map((e) => e.devState), [undefined, undefined]);
});
