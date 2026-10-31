/* When a run's suite is worth keeping: the same facts decide() reads, asked without regard to where a pull request would go. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isAccepted, type RunEvidence } from "@contexts/run-orchestration/domain/run-decision.service.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";

const RUN_VERDICTS: readonly RunVerdict[] = ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"];

function evidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return { verdict: "pass", generating: true, needsReview: true, reviewerApproved: true, blocksPublish: false, shadow: false, onFailure: "github-issue", ...overrides };
}

test("a green run that generated, was approved and is not held back by coverage is accepted", () => {
  assert.equal(isAccepted(evidence()), true);
});

test("a run whose review is not required is accepted without an approval", () => {
  assert.equal(isAccepted(evidence({ needsReview: false, reviewerApproved: false })), true);
});

test("a rejected review, a coverage block, or a run that generated nothing is not accepted", () => {
  assert.equal(isAccepted(evidence({ reviewerApproved: false })), false);
  assert.equal(isAccepted(evidence({ blocksPublish: true })), false);
  assert.equal(isAccepted(evidence({ generating: false })), false);
});

test("only a pass is accepted: a flaky run is never admitted, nor is any other verdict", () => {
  for (const verdict of RUN_VERDICTS) {
    assert.equal(isAccepted(evidence({ verdict })), verdict === "pass", verdict);
  }
});

test("shadow mode and the failure-report setting do not change acceptance: nothing is published in shadow, and the suite is still kept", () => {
  assert.equal(isAccepted(evidence({ shadow: true })), true);
  assert.equal(isAccepted(evidence({ onFailure: "none" })), true);
  assert.equal(isAccepted(evidence({ shadow: true, reviewerApproved: false })), false);
});

test("an accepted run is exactly a run decide() would send to a pull request when it is not in shadow", () => {
  const flags = [true, false];
  for (const verdict of RUN_VERDICTS) {
    for (const generating of flags) {
      for (const needsReview of flags) {
        for (const reviewerApproved of flags) {
          for (const blocksPublish of flags) {
            for (const shadow of flags) {
              const ev = evidence({ verdict, generating, needsReview, reviewerApproved, blocksPublish, shadow });
              const wouldPublish = decide({ ...ev, shadow: false }).sideEffect === "pr";
              assert.equal(isAccepted(ev), wouldPublish, JSON.stringify(ev));
            }
          }
        }
      }
    }
  }
});
