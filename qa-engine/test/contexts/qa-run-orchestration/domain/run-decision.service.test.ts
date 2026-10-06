import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type RunEvidence } from "@contexts/qa-run-orchestration/domain/run-decision.service.ts";

function baseEvidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    verdict: "pass",
    generating: true,
    needsReview: true,
    reviewerApproved: true,
    blocksPublish: false,
    shadow: false,
    onFailure: "github-issue",
    ...overrides,
  };
}

test("decide: verdict=fail -> issue", () => {
  const decision = decide(baseEvidence({ verdict: "fail" }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: verdict=invalid -> issue", () => {
  const decision = decide(baseEvidence({ verdict: "invalid" }));
  assert.equal(decision.verdict, "invalid");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: verdict=infra-error -> none (log-only, never reported as a bug)", () => {
  const decision = decide(baseEvidence({ verdict: "infra-error" }));
  assert.equal(decision.verdict, "infra-error");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=flaky -> quarantine (no PR, no Issue)", () => {
  const decision = decide(baseEvidence({ verdict: "flaky" }));
  assert.equal(decision.verdict, "flaky");
  assert.equal(decision.sideEffect, "quarantine");
});

/* Issue into "shadow-log", never a real openIssue call. flaky/infra-error are shadow-invariant
   (report()'s switch never calls issueOrShadow for those two cases).
 */

test("decide: verdict=fail + shadow -> shadow-log", () => {
  const decision = decide(baseEvidence({ verdict: "fail", shadow: true }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "shadow-log");
});

test("decide: verdict=invalid + shadow -> shadow-log", () => {
  const decision = decide(baseEvidence({ verdict: "invalid", shadow: true }));
  assert.equal(decision.verdict, "invalid");
  assert.equal(decision.sideEffect, "shadow-log");
});

test("decide: verdict=infra-error + shadow -> none (shadow-invariant)", () => {
  const decision = decide(baseEvidence({ verdict: "infra-error", shadow: true }));
  assert.equal(decision.verdict, "infra-error");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=flaky + shadow -> quarantine (shadow-invariant)", () => {
  const decision = decide(baseEvidence({ verdict: "flaky", shadow: true }));
  assert.equal(decision.verdict, "flaky");
  assert.equal(decision.sideEffect, "quarantine");
});

test("decide: verdict=fail + onFailure!=='github-issue' -> none (the onFailure guard suppresses every report)", () => {
  const decision = decide(baseEvidence({ verdict: "fail", onFailure: "none" }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=invalid + onFailure!=='github-issue' -> none (the onFailure guard suppresses every report)", () => {
  const decision = decide(baseEvidence({ verdict: "invalid", onFailure: "none" }));
  assert.equal(decision.verdict, "invalid");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=flaky + onFailure!=='github-issue' -> quarantine (unaffected — the guard branch itself sets the SAME 'flaky — quarantined' outcome)", () => {
  const decision = decide(baseEvidence({ verdict: "flaky", onFailure: "none" }));
  assert.equal(decision.verdict, "flaky");
  assert.equal(decision.sideEffect, "quarantine");
});

test("decide: verdict=infra-error + onFailure!=='github-issue' -> none (unaffected — infra-error is 'none' either side of the guard)", () => {
  const decision = decide(baseEvidence({ verdict: "infra-error", onFailure: "none" }));
  assert.equal(decision.verdict, "infra-error");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=fail + onFailure!=='github-issue' + shadow -> none (the onFailure guard is checked BEFORE shadow — shadow is irrelevant once the guard suppresses the report)", () => {
  const decision = decide(baseEvidence({ verdict: "fail", onFailure: "none", shadow: true }));
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "none");
});

/* ── Two early "skipped" exits (silent — never reach report()) ─────────────────────────────────── */

test("decide: verdict=skipped (classify-skip) -> none", () => {
  const decision = decide(baseEvidence({ verdict: "skipped", generating: false }));
  assert.equal(decision.verdict, "skipped");
  assert.equal(decision.sideEffect, "none");
});

test("decide: verdict=skipped (agent no-op) -> none", () => {
  const decision = decide(baseEvidence({ verdict: "skipped", generating: true }));
  assert.equal(decision.verdict, "skipped");
  assert.equal(decision.sideEffect, "none");
});

test("decide: pass + !generating -> none (regression green, no new tests to publish)", () => {
  const decision = decide(baseEvidence({ verdict: "pass", generating: false }));
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "none");
});

test("decide: pass + generating + needsReview + !reviewerApproved -> issue (reviewer rejected)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: true, reviewerApproved: false }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: pass + generating + reviewer OK + blocksPublish -> issue (coverage gate holds the PR)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: true }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "issue");
});

test("decide: pass + generating + reviewer OK + no coverage block + shadow -> shadow-log", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, blocksPublish: false, shadow: true }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "shadow-log");
});

test("decide: pass + generating + reviewer OK + no coverage block + !shadow -> pr (the green publish path)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, blocksPublish: false, shadow: false }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "pr");
});

test("decide: needsReview=false short-circuits the reviewer-rejection branch even if reviewerApproved=false (the rejection branch is `needsReview && !approved`)", () => {
  /* Mirrors apps that set qa.needsReview=false (e.g. the crossApp/adjudicator scenario fixtures) —
     reviewerApproved is irrelevant when the app never asked for review; the chain falls through to
     the coverage/shadow/publish branches exactly like a reviewer-approved run would.
   */
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: false, reviewerApproved: false, blocksPublish: false, shadow: false }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "pr");
});

/* ── Precedence pins: earlier branches must win over later ones when multiple conditions hold ──── */

test("decide: precedence — verdict!=='pass' wins over every pass-path condition (a fail verdict ignores blocksPublish/needsReview, shadow:false so no shadow-fold applies)", () => {
  const decision = decide(
    baseEvidence({ verdict: "fail", generating: true, needsReview: true, reviewerApproved: false, blocksPublish: true, shadow: false }),
  );
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "issue", "fail must route through report()'s switch, not fall through to shadow/coverage/reviewer checks");
});

test("decide: precedence — verdict!=='pass' + shadow:true folds to shadow-log", () => {
  const decision = decide(
    baseEvidence({ verdict: "fail", generating: true, needsReview: true, reviewerApproved: false, blocksPublish: true, shadow: true }),
  );
  assert.equal(decision.verdict, "fail");
  assert.equal(decision.sideEffect, "shadow-log", "shadow uniformly folds every would-be issue/pr, even for a fail verdict short-circuiting before the pass-path");
});

test("decide: precedence — reviewer rejection wins over blocksPublish and shadow (needsReview/approved is checked BEFORE blocksPublish BEFORE shadow) — shadow:true folds the outcome to shadow-log, not issue", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: true, reviewerApproved: false, blocksPublish: true, shadow: true }),
  );
  assert.equal(decision.sideEffect, "shadow-log", "reviewer rejection (checked first in the else-if chain) must win over both blocksPublish and shadow's own branch — but the shadow flag still folds issue->shadow-log via issueOrShadow");
});

test("decide: precedence — blocksPublish wins over shadow's own branch (coverage gate is checked BEFORE the shadow branch) — shadow:true folds the outcome to shadow-log, not issue", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: false, blocksPublish: true, shadow: true }),
  );
  assert.equal(decision.sideEffect, "shadow-log", "blocksPublish (checked before the shadow branch in the else-if chain) must win over the shadow-log branch's OWN precedence slot — but the shadow flag still folds issue->shadow-log via issueOrShadow");
});
