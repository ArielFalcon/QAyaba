import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderRubricCsv, summarize, type ArmRunResult, type CampaignRecord } from "./campaign-report.ts";

function result(over: Partial<ArmRunResult> = {}): ArmRunResult {
  return {
    caseId: "dup-address", arm: "A", replicate: 1, position: 1, label: "camp-dup-address-A1", runId: null,
    verdict: "pass", errorClass: null, note: null, outcome: "spec", matchesExpected: true,
    delivered: ["address.spec.ts"], savedTo: "dup-address/A-1/files",
    specs: [{ path: "address.spec.ts", flags: [], ran: true, runs: ["pass", "pass"], valid: true }], validationRuns: [{ verdict: "pass" }, { verdict: "pass" }],
    valid: true, rubric: "pending", costUsd: 0.5, wallMs: 120_000, wallExclOracleMs: 120_000, steps: 40, start: "warm", loginRewritten: false, capped: false,
    invalidReplicate: false, invalidReasons: [], ...over,
  };
}

function record(results: ArmRunResult[]): CampaignRecord {
  return {
    schema: 1, label: "camp", app: "demo", startedAt: "2026-10-12T10:00:00.000Z", finishedAt: "2026-10-12T12:00:00.000Z", complete: true,
    args: { replicas: 2, arms: ["A", "B"], wallCapMin: 30, warm: "warm-1", casesPath: "cases.json" },
    environment: { campaignFreeze: true, preserveUntrackedSuite: true, engramIsolated: false, appShadow: true, forcedShadow: true },
    snapshot: { label: "warm-1", createdAt: "2026-10-11T10:00:00.000Z", warm: true },
    cases: [{ id: "dup-address", kind: "diff", sha: "abc1234", expected: { outcome: "spec", mustVerify: "a duplicate address shows the refusal" } }],
    results,
  };
}

test("the summary counts a replicate toward an arm's validity only when it could be compared", () => {
  const rows = summarize([
    result({ replicate: 1 }),
    result({ replicate: 2, valid: false, specs: [{ path: "a.spec.ts", flags: [], ran: true, runs: ["pass", "fail"], valid: false }] }),
    result({ replicate: 3, invalidReplicate: true, invalidReasons: ["the wall cap cut the run"], valid: true }),
  ]);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.replicates, 3);
  assert.equal(row.usable, 2);
  assert.equal(row.valid, 1);
});

test("the summary keeps the arms and the cases apart", () => {
  const rows = summarize([result({ arm: "A" }), result({ arm: "B", replicate: 1 }), result({ caseId: "other", arm: "A" })]);
  assert.deepEqual(rows.map((r) => `${r.caseId}/${r.arm}`).sort(), ["dup-address/A", "dup-address/B", "other/A"]);
});

test("medians come from the figures that are known, and an arm with none reads unknown, never zero", () => {
  const [row] = summarize([result({ costUsd: 1, wallMs: 100_000, steps: 10 }), result({ replicate: 2, costUsd: 3, wallMs: 300_000, steps: null }), result({ replicate: 3, costUsd: null, wallMs: null, steps: null })]);
  assert.equal(row!.medianCostUsd, 2);
  assert.equal(row!.medianWallMs, 200_000);
  assert.equal(row!.medianSteps, 10);
  const [unknown] = summarize([result({ costUsd: null, wallMs: null, steps: null })]);
  assert.equal(unknown!.medianCostUsd, null);
  assert.equal(unknown!.medianWallMs, null);
  assert.equal(unknown!.medianSteps, null);
});

test("the markdown carries one row per arm-run with its verdict, validity and flags, and an unknown figure reads n/a", () => {
  const flagged = result({
    arm: "B", replicate: 2, valid: false, costUsd: null, steps: null,
    specs: [{ path: "x.spec.ts", flags: [{ kind: "tautological-expect", detail: "expect(true) asserts on a literal" }], ran: false, runs: [], valid: false }],
  });
  const text = renderMarkdown(record([result(), flagged]));
  assert.ok(text.includes("dup-address"));
  assert.ok(text.includes("tautological-expect"), "the flag is named");
  assert.ok(text.includes("n/a"), "unknown figures are n/a");
  assert.ok(text.includes("warm-1"), "the snapshot is named");
});

test("the markdown says what the campaign could not isolate", () => {
  const text = renderMarkdown(record([result()]));
  assert.ok(/engram/i.test(text), "agent memory carry-over is stated");
  const attested = renderMarkdown({ ...record([result()]), environment: { ...record([]).environment, engramIsolated: true } });
  assert.notEqual(text, attested);
});

test("an invalid replicate is marked with why, so it is not read as the arm's result", () => {
  const text = renderMarkdown(record([result({ invalidReplicate: true, invalidReasons: ["the wall cap cut the run"], capped: true })]));
  assert.ok(text.includes("the wall cap cut the run"));
});

test("a campaign that did not finish says so", () => {
  const text = renderMarkdown({ ...record([result()]), complete: false, finishedAt: null });
  assert.ok(/incomplete|did not finish|stopped/i.test(text));
});

test("the rubric lists only the valid candidates, with what each must verify and where its files are", () => {
  const csv = renderRubricCsv(record([
    result({ replicate: 1 }),
    result({ replicate: 2, valid: false }),
    result({ replicate: 3, invalidReplicate: true }),
    result({ arm: "B", replicate: 1, savedTo: "dup-address/B-1/files", delivered: ["a.spec.ts", "b.spec.ts"] }),
  ]));
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3, "a header and the two valid candidates");
  assert.ok(lines[1]!.includes("dup-address/A-1/files"));
  assert.ok(lines[1]!.includes("a duplicate address shows the refusal"));
  assert.ok(lines[2]!.includes("dup-address/B-1/files"));
  assert.ok(lines[0]!.includes("score"), "a column for the owner's 0-3");
});

test("a field with a comma, a quote or a newline stays one field in the rubric", () => {
  const rec = record([result()]);
  rec.cases[0]!.expected.mustVerify = 'shows "refused", twice\nand more';
  const csv = renderRubricCsv(rec);
  assert.ok(csv.includes('"shows ""refused"", twice and more"'));
});
