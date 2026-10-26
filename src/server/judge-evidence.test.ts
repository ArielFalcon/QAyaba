import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryJudgeEvidence, extractCommitDiff, type JudgeEvidenceDeps } from "./judge-evidence";
import { COMMIT_DIFF_HEADING } from "@contexts/generation/infrastructure/prompt-builders/prompts";
import type { AgentTurnRecord, SpecSnapshotRow } from "./history";
import type { RunRecord } from "../types";

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
const promptWith = (diff: string): string => ["## Task", "do it", "", COMMIT_DIFF_HEADING, "```diff", diff, "```", "", "## Output", "json"].join("\n");

test("the diff is read back from the section a prompt holds it in, and only from there", () => {
  assert.equal(extractCommitDiff(promptWith(DIFF)), DIFF);
  assert.equal(extractCommitDiff("## Task\nnothing to see"), undefined);
  assert.equal(extractCommitDiff(`${COMMIT_DIFF_HEADING}\nno fence here`), undefined);
  assert.equal(extractCommitDiff(promptWith("")), undefined, "an empty diff is no diff");
});

function turn(over: Partial<AgentTurnRecord>): AgentTurnRecord {
  return { runId: "r", sessionId: "s", role: "qa-author", round: 0, isRepair: false, ts: "2026-10-18T10:00:00.000Z", objective: null, promptText: "", outputText: "", promptBytes: 0, tokensInput: null, tokensOutput: null, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: null, ...over };
}

function snap(path: string, text: string, capturedAt: number, delivered = 1): SpecSnapshotRow {
  return { runId: "r", path, sha256: `${path}${capturedAt}`, text, bytes: text.length, capturedAt, delivered };
}

function deps(over: { record?: Partial<RunRecord> | null; turns?: AgentTurnRecord[]; snaps?: SpecSnapshotRow[]; cancelled?: boolean; errorClass?: string; plan?: string } = {}): JudgeEvidenceDeps {
  const record = over.record === null ? undefined : ({ id: "r", app: "a", mode: "diff", status: "done", verdict: "fail", cases: [], at: "2026-10-18T09:00:00.000Z", ...over.record } as RunRecord);
  return {
    getRecord: () => record,
    getRunFacts: () => ({ cancelled: over.cancelled ?? false }) as ReturnType<JudgeEvidenceDeps["getRunFacts"]>,
    getRunPhases: () => ({ furthestPhase: "execute" }) as ReturnType<JudgeEvidenceDeps["getRunPhases"]>,
    getRunOutcome: () => (over.errorClass ? ({ errorClass: over.errorClass } as ReturnType<JudgeEvidenceDeps["getRunOutcome"]>) : undefined),
    getAgentTurns: () => over.turns ?? [],
    listSpecSnapshots: () => over.snaps ?? [],
    getRunPlan: () => over.plan,
  };
}

test("a finished run's evidence carries its diff, the specs it delivered and the messages of its failed cases", () => {
  const evidence = new HistoryJudgeEvidence(
    deps({
      record: { cases: [{ name: "a works", status: "fail", detail: "Timeout 5000ms" }, { name: "b works", status: "pass" }] },
      turns: [turn({ promptText: promptWith(DIFF) })],
      snaps: [snap("e2e/a.spec.ts", "test()", 1)],
    }),
  ).load("r");
  assert.ok(evidence);
  assert.equal(evidence.diff, DIFF);
  assert.deepEqual(evidence.specs, [{ path: "e2e/a.spec.ts", text: "test()" }]);
  assert.deepEqual(evidence.failures, [{ name: "a works", message: "Timeout 5000ms" }]);
  assert.equal(evidence.furthestPhase, "execute");
});

test("a run still running, or unknown, has no evidence", () => {
  assert.equal(new HistoryJudgeEvidence(deps({ record: { status: "running", verdict: undefined } })).load("r"), undefined);
  assert.equal(new HistoryJudgeEvidence(deps({ record: null })).load("r"), undefined);
});

test("the newest snapshot of a spec wins, and a spec the run only read and did not deliver is left out", () => {
  const evidence = new HistoryJudgeEvidence(deps({ snaps: [snap("e2e/a.spec.ts", "v1", 1), snap("e2e/a.spec.ts", "v2", 2), snap("e2e/other.spec.ts", "untouched", 3, 0)] })).load("r");
  assert.deepEqual(evidence?.specs, [{ path: "e2e/a.spec.ts", text: "v2" }]);
});

test("the diff comes from the first generation prompt that held one, not from a repair or a prompt without it", () => {
  const evidence = new HistoryJudgeEvidence(
    deps({
      turns: [
        turn({ role: "qa-reflector", promptText: promptWith("diff --git a/x b/x\n+other") }),
        turn({ ts: "2026-10-18T10:01:00.000Z", round: 1, isRepair: true, promptText: promptWith("diff --git a/y b/y\n+repair") }),
        turn({ ts: "2026-10-18T10:00:00.000Z", promptText: promptWith(DIFF) }),
      ],
    }),
  ).load("r");
  assert.equal(evidence?.diff, DIFF);
});

test("a run with no turn history has no diff, and a failed case without detail still has a message", () => {
  const evidence = new HistoryJudgeEvidence(deps({ record: { cases: [{ name: "c", status: "fail" }] } })).load("r");
  assert.equal(evidence?.diff, undefined);
  assert.equal(evidence?.failures[0]?.name, "c");
  assert.ok((evidence?.failures[0]?.message ?? "").length > 0);
});

test("the error class and the cancelled flag travel with the evidence", () => {
  const evidence = new HistoryJudgeEvidence(deps({ errorClass: "E-SANDBOX", cancelled: true, record: { verdict: "infra-error" } })).load("r");
  assert.equal(evidence?.errorClass, "E-SANDBOX");
  assert.equal(evidence?.cancelled, true);
});

test("the judges read the flows of the plan the run kept, and a run that kept none or an unreadable one has none", () => {
  const plan = JSON.stringify({ kind: "fanout", flows: [{ id: "cart", objective: "the cart total", acceptance: ["adds the fee", 3], routes: ["/cart"] }, { objective: "no id" }] });
  assert.deepEqual(new HistoryJudgeEvidence(deps({ plan })).load("r")!.plan, [{ id: "cart", objective: "the cart total", acceptance: ["adds the fee"] }]);
  assert.deepEqual(new HistoryJudgeEvidence(deps()).load("r")!.plan, []);
  assert.deepEqual(new HistoryJudgeEvidence(deps({ plan: "{nope" })).load("r")!.plan, []);
});

test("the evidence carries the candidates the run's plan kept, with the pages and specs of each, and none for a plan that kept no candidates", () => {
  const plan = JSON.stringify({
    kind: "fanout",
    flows: [],
    candidates: [
      { id: "uc-1", entry: "page /cart", tier: "direct", reachability: "page", state: "planned", pages: ["/cart"], existingSpecs: ["e2e/cart.spec.ts"] },
      { id: "uc-2", tier: "direct", reachability: "backend-only", state: "unplanned" },
      { reachability: "page" },
    ],
  });
  assert.deepEqual(new HistoryJudgeEvidence(deps({ plan })).load("r")!.candidates, [
    { id: "uc-1", entry: "page /cart", tier: "direct", reachability: "page", pages: ["/cart"], existingSpecs: ["e2e/cart.spec.ts"] },
    { id: "uc-2", entry: "", tier: "direct", reachability: "backend-only", pages: [], existingSpecs: [] },
  ]);
  assert.deepEqual(new HistoryJudgeEvidence(deps({ plan: JSON.stringify({ kind: "noop", flows: [] }) })).load("r")!.candidates, []);
});
