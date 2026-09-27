import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProgressSnapshot,
  evidenceFromExecution,
  routeOrchestration,
  sameProgress,
  type AgentCapability,
  type EvidenceRef,
  type RouterInput,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

/* ── progress snapshots: what counts as "the same progress" ──────────────────────────────────── */

test("the same failing set in any order, with the same changed files and signals, is the same progress", () => {
  const a = buildProgressSnapshot({
    failureClass: "selector",
    failingNames: ["login", "checkout"],
    changedFiles: ["a.ts", "b.ts"],
    selectorContradictions: ["x", "y"],
    coverageStatus: "fail",
    mutationSignal: "weak",
  });
  const b = buildProgressSnapshot({
    failureClass: "selector",
    failingNames: ["checkout", "login"],
    changedFiles: ["b.ts", "a.ts"],
    selectorContradictions: ["y", "x"],
    coverageStatus: "fail",
    mutationSignal: "weak",
  });
  assert.equal(sameProgress(a, b), true);
});

test("a change in any tracked signal is progress", () => {
  const base = {
    failureClass: "selector",
    failingNames: ["login"],
    changedFiles: ["a.ts"],
    selectorContradictions: ["x"],
    coverageStatus: "fail",
    mutationSignal: "weak",
  };
  const snap = buildProgressSnapshot(base);
  for (const changed of [
    { failingNames: ["checkout"] },
    { changedFiles: ["b.ts"] },
    { selectorContradictions: ["y"] },
    { coverageStatus: "pass" },
    { mutationSignal: "strong" },
  ]) {
    assert.equal(sameProgress(snap, buildProgressSnapshot({ ...base, ...changed })), false, JSON.stringify(changed));
  }
});

test("building a snapshot leaves the caller's failing-name list in its own order", () => {
  const failingNames = ["login", "checkout"];
  buildProgressSnapshot({ failingNames });
  assert.deepEqual(failingNames, ["login", "checkout"]);
});

test("failing sets that only differ in where names split are different progress", () => {
  assert.equal(
    sameProgress(buildProgressSnapshot({ failingNames: ["ab", "c"] }), buildProgressSnapshot({ failingNames: ["a", "bc"] })),
    false,
  );
});

/* ── routing ─────────────────────────────────────────────────────────────────────────────────── */

const snap = buildProgressSnapshot({ failureClass: "selector", failingNames: ["login"] });

function route(overrides: Partial<RouterInput> = {}) {
  return routeOrchestration({
    evidence: [],
    currentCapability: "sidekick-standard",
    current: snap,
    budgetExhausted: false,
    infraFailure: false,
    ...overrides,
  });
}

const agentSaysDone: EvidenceRef = { id: "agent", kind: "agent-observation", source: "sidekick", summary: "completed", confidence: "observed" };

test("a deterministic failure contradicting the agent's success hands over to the lead, naming the contradiction", () => {
  const failing = evidenceFromExecution({ verdict: "fail", failing: 2 });
  const decision = route({ evidence: [agentSaysDone, failing] });
  assert.equal(decision.action, "lead-takeover");
  assert.equal(decision.nextCapability, "lead");
  assert.ok(decision.reason.includes(failing.summary));
});

test("no progress escalates one rung per capability: standard → escalated → lead → FixLoop", () => {
  const stalled = (currentCapability: AgentCapability) => route({ currentCapability, previous: snap, current: snap });
  assert.deepEqual([stalled("sidekick-standard").action, stalled("sidekick-standard").nextCapability], ["escalate-sidekick", "sidekick-escalated"]);
  assert.deepEqual([stalled("sidekick-escalated").action, stalled("sidekick-escalated").nextCapability], ["lead-takeover", "lead"]);
  assert.equal(stalled("lead").action, "continue-fix-loop");
});

test("a sidekick that asks for the lead gets a lead takeover", () => {
  const decision = route({ sidekickNeedsLead: true });
  assert.equal(decision.action, "lead-takeover");
  assert.equal(decision.nextCapability, "lead");
});

test("with progress and nothing else to act on, a sidekick retries at its own capability and the lead's path is accepted", () => {
  const sidekick = route({ currentCapability: "sidekick-escalated" });
  assert.equal(sidekick.action, "retry-sidekick");
  assert.equal(sidekick.nextCapability, "sidekick-escalated");
  assert.equal(route({ currentCapability: "lead" }).action, "accept");
});

test("every routing decision explains itself", () => {
  const decisions = [
    route({ infraFailure: true }),
    route({ budgetExhausted: true }),
    route({ evidence: [agentSaysDone, evidenceFromExecution({ verdict: "fail", failing: 1 })] }),
    route({ previous: snap }),
    route({ currentCapability: "sidekick-escalated", previous: snap }),
    route({ currentCapability: "lead", previous: snap }),
    route({ sidekickNeedsLead: true }),
    route({ qaCorrectionOwnedByFixLoop: true }),
    route(),
    route({ currentCapability: "lead" }),
  ];
  for (const d of decisions) assert.ok(d.reason.trim().length > 0, `${d.action} has no reason`);
});
