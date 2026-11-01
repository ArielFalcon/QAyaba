import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isAccepted, type RunEvidence } from "@contexts/run-orchestration/domain/run-decision.service.ts";

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

test("decide: pass + generating + reviewer OK + blocksPublish -> held (the coverage gate holds the PR: no PR and no Issue)", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: true }),
  );
  assert.equal(decision.verdict, "pass");
  assert.equal(decision.sideEffect, "held");
  assert.equal(decision.outcome, "held");
  assert.equal(decision.shadowed, false);
});

test("decide: a coverage block holds only a pass that would have published: every other verdict keeps its own decision", () => {
  for (const [ev, sideEffect] of [
    [{ verdict: "fail" }, "issue"],
    [{ verdict: "invalid" }, "issue"],
    [{ verdict: "flaky" }, "quarantine"],
    [{ verdict: "infra-error" }, "none"],
    [{ verdict: "skipped" }, "none"],
    [{ generating: false }, "none"],
    [{ reviewerApproved: false }, "issue"],
  ] as const) {
    assert.equal(decide(baseEvidence({ ...ev, blocksPublish: true })).sideEffect, sideEffect, JSON.stringify(ev));
  }
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

test("decide: precedence — blocksPublish wins over shadow's own branch (the coverage gate is checked BEFORE the shadow branch) — a held decision opens nothing, so shadow has nothing to replace", () => {
  const decision = decide(
    baseEvidence({ verdict: "pass", generating: true, needsReview: false, blocksPublish: true, shadow: true }),
  );
  assert.equal(decision.sideEffect, "held");
  assert.equal(decision.shadowed, false);
});

/* The decision in one vocabulary: what the run decided, and apart from it whether shadow replaced it. */

test("decide: a live decision is its own outcome and is not shadowed", () => {
  for (const [ev, outcome] of [
    [{ verdict: "fail" }, "issue"],
    [{}, "pr"],
    [{ verdict: "flaky" }, "quarantine"],
    [{ verdict: "infra-error" }, "none"],
    [{ blocksPublish: true }, "held"],
  ] as const) {
    const decision = decide(baseEvidence(ev));
    assert.equal(decision.outcome, outcome);
    assert.equal(decision.shadowed, false);
  }
});

test("decide: shadow keeps what the run decided and says it replaced it", () => {
  const cases: Array<[Partial<RunEvidence>, string, string]> = [
    [{ shadow: true }, "pr", "shadow-log"],
    [{ shadow: true, verdict: "fail" }, "issue", "shadow-log"],
    [{ shadow: true, reviewerApproved: false }, "issue", "shadow-log"],
  ];
  for (const [ev, outcome, sideEffect] of cases) {
    const decision = decide(baseEvidence(ev));
    assert.equal(decision.outcome, outcome);
    assert.equal(decision.shadowed, true);
    assert.equal(decision.sideEffect, sideEffect, "what ran does not change");
  }
});

test("decide: shadow does not touch a decision that opens nothing", () => {
  for (const [ev, outcome] of [
    [{ verdict: "flaky" }, "quarantine"],
    [{ verdict: "infra-error" }, "none"],
    [{ verdict: "skipped" }, "none"],
    [{ generating: false }, "none"],
    [{ blocksPublish: true }, "held"],
  ] as const) {
    const decision = decide(baseEvidence({ ...ev, shadow: true }));
    assert.equal(decision.outcome, outcome);
    assert.equal(decision.shadowed, false);
  }
});

test("decide: a green run that found a defect ends fail and opens an Issue, under the same shadow and report rules as any fail", () => {
  const found = decide(baseEvidence({ defectFound: true }));
  assert.equal(found.verdict, "fail");
  assert.equal(found.sideEffect, "issue");
  assert.equal(decide(baseEvidence({ defectFound: true, shadow: true })).sideEffect, "shadow-log");
  assert.equal(decide(baseEvidence({ defectFound: true, onFailure: "none" })).sideEffect, "none");
});

test("decide: a defect found changes no verdict other than a pass", () => {
  for (const verdict of ["flaky", "invalid", "infra-error", "skipped"] as const) {
    assert.equal(decide(baseEvidence({ verdict, defectFound: true })).verdict, verdict, verdict);
  }
});

test("decide: a defect found opens an Issue beside any verdict, which keeps its own, and the report and shadow rules hold", () => {
  for (const verdict of ["flaky", "infra-error", "skipped"] as const) {
    const found = decide(baseEvidence({ verdict, defectFound: true }));
    assert.equal(found.verdict, verdict, verdict);
    assert.equal(found.sideEffect, "issue", verdict);
    assert.equal(decide(baseEvidence({ verdict, defectFound: true, shadow: true })).sideEffect, "shadow-log", verdict);
  }
  assert.equal(decide(baseEvidence({ verdict: "flaky", defectFound: true, onFailure: "none" })).sideEffect, "quarantine", "a report that opens no Issue still quarantines the flaky case");
  assert.equal(decide(baseEvidence({ verdict: "skipped", defectFound: true, onFailure: "none" })).sideEffect, "none");
});

test("decide: a run with no defect keeps the flaky quarantine and the silent infra-error and skip", () => {
  assert.equal(decide(baseEvidence({ verdict: "flaky", defectFound: false })).sideEffect, "quarantine");
  assert.equal(decide(baseEvidence({ verdict: "infra-error", defectFound: false })).sideEffect, "none");
  assert.equal(decide(baseEvidence({ verdict: "skipped" })).sideEffect, "none");
});

test("a pass run that needs a review publishes only on a real approval: no verdict is no approval", () => {
  assert.equal(decide(baseEvidence({ reviewerApproved: true })).sideEffect, "pr");
  assert.equal(decide(baseEvidence({ reviewerApproved: false })).sideEffect, "issue");
  const noVerdict = baseEvidence();
  delete noVerdict.reviewerApproved;
  assert.equal(decide(noVerdict).sideEffect, "issue", "no reviewer reached a verdict, so nothing is published on its behalf");
  assert.equal(isAccepted(noVerdict), false, "and the suite it never approved is not kept");
});
