import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewerApprovalOf } from "@contexts/qa-run-orchestration/application/ports/index.ts";

test("a generation that was reviewed reports the reviewer's approval, whichever way it went", () => {
  assert.equal(reviewerApprovalOf({ reviewed: true, approved: true }), true);
  assert.equal(reviewerApprovalOf({ reviewed: true, approved: false }), false);
});

test("a generation no reviewer looked at reports no approval at all, never the placeholder flag", () => {
  assert.equal(reviewerApprovalOf({ reviewed: false, approved: true }), undefined);
  assert.equal(reviewerApprovalOf({ reviewed: false, approved: false }), undefined);
});
