import { test } from "node:test";
import assert from "node:assert/strict";
import { campaignRunsView, matchesVariant, type CampaignRunRow } from "@contexts/evaluation/domain/campaign-runs.ts";

const row = (id: string, variant: Record<string, string>, over: Partial<CampaignRunRow> = {}): CampaignRunRow => ({
  id,
  variant,
  replicate: 1,
  status: "done",
  verdict: "pass",
  evaluationStatus: "complete",
  ...over,
});

test("a campaign is complete only when every run is done and graded", () => {
  const rows = [row("a", { arm: "x" }), row("b", { arm: "y" })];
  assert.equal(campaignRunsView(rows).complete, true);
  assert.equal(campaignRunsView([...rows, row("c", { arm: "y" }, { evaluationStatus: null })]).complete, false);
  assert.equal(campaignRunsView([...rows, row("c", { arm: "y" }, { status: "running", verdict: null })]).complete, false);
  assert.equal(campaignRunsView([...rows, row("c", { arm: "y" }, { evaluationStatus: "failed" })]).complete, false);
});

test("a campaign with no run is not complete", () => {
  assert.deepEqual(campaignRunsView([]), { runs: [], complete: false });
});

test("an ungraded run reads as pending, and a run without a verdict has none", () => {
  const view = campaignRunsView([row("a", {}, { evaluationStatus: null, verdict: null, status: "enqueued" })]);
  assert.equal(view.runs[0]!.evaluationStatus, "pending");
  assert.equal("verdict" in view.runs[0]!, false);
});

test("the variant filter keeps the runs that carry every named label, and completeness is judged on them", () => {
  const rows = [row("a", { arm: "x", model: "m1" }), row("b", { arm: "y", model: "m1" }, { evaluationStatus: null })];
  const arm = campaignRunsView(rows, { arm: "x" });
  assert.deepEqual(arm.runs.map((r) => r.id), ["a"]);
  assert.equal(arm.complete, true);
  assert.deepEqual(campaignRunsView(rows, { model: "m1" }).runs.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(campaignRunsView(rows, { arm: "x", model: "m2" }).runs, []);
});

test("a filter key a run does not carry never matches, even for an inherited property name", () => {
  assert.equal(matchesVariant({ arm: "x" }, { toString: "x" }), false);
  assert.equal(matchesVariant({}, {}), true);
});
