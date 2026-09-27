/* fold() maps applyOutcome and retrieve() to topRules. Off-path by contract: a fold failure is
   logged and swallowed, NEVER thrown/re-raised — the caller (RunQaUseCase) must never see a
   learning fault. retrieve() projects the FULL structured RetrievedRule shape
   (trigger/action/errorClass/status/confidence), not bare trigger strings, and calls the store's
   optional incrementUsage on exactly the retrieved ids.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LearningPortAdapter, DEFAULT_RULES_CHAR_BUDGET } from "@contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter.ts";
import { SqliteLearningRepository, type LearningRow, type LearningStore } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts";
import { renderLearnedRules } from "@contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts";
import { StubLearningRepository } from "@contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts";
import type { LearningRepositoryPort, LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";
import type { RelevanceBias } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

const outcome: RunOutcome = {
  runId: "r1", app: "app", sha: "abc1234", mode: "diff", target: "e2e", verdict: "pass",
  errorClass: null,
  gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
  rulesRetrieved: [], at: new Date().toISOString(),
};

test("fold() delegates to LearningRepositoryPort.applyOutcome verbatim", async () => {
  let captured: RunOutcome | undefined;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [],
    applyOutcome: async (o) => { captured = o; },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await adapter.fold(outcome);

  assert.equal(captured, outcome);
});

test("fold() swallows a failure — off-path by contract, never gates publish", async () => {
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [],
    applyOutcome: async () => { throw new Error("sqlite is locked"); },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  /* Must NOT throw/reject — a fold failure is logged and swallowed, per the port's own contract. */
  await assert.doesNotReject(() => adapter.fold(outcome));
});

test("retrieve() delegates to LearningRepositoryPort.topRules and returns the FULL structured rule (W3 F1)", async () => {
  const rule: LearningRule = {
    id: "r1", trigger: "selector absent", action: "use role+name", errorClass: "E-EXEC-FAIL",
    archetype: null, status: "active", confidence: "high", usageCount: 3, outcomeCount: 3,
    oracleOutcomeCount: 3, successRate: 1, lastVerified: null, source: "run-1", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result, [{
    id: "r1",
    trigger: "selector absent",
    action: "use role+name",
    errorClass: "E-EXEC-FAIL",
    status: "active",
    confidence: "high",
  }]);
});

/* repository row's real id at this exact projection — RunOutcome.rulesRetrieved persisted trigger
   TEXT instead of ids, so the factory's by-id fold (rewritten-engine-factory.ts's recordOutcome)
   missed every row and outcome_count stayed frozen at 0 forever (no promotion/demotion ever
   engaged). This test pins the id surviving the LearningRule -> RetrievedRule projection —
   it is the row's PRIMARY KEY used for outcome-fold attribution, distinct from `trigger` (the
   prompt-facing text).
 */
test("retrieve() includes the repository row's real id in each RetrievedRule (WS1.1 fold-attribution fix)", async () => {
  const rule: LearningRule = {
    id: "rule-id-distinct-from-trigger", trigger: "selector absent", action: "use role+name",
    errorClass: "E-EXEC-FAIL", archetype: null, status: "active", confidence: "high",
    usageCount: 3, outcomeCount: 3, oracleOutcomeCount: 3, successRate: 1, lastVerified: null, source: "run-1",
    at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.equal(result[0]?.id, "rule-id-distinct-from-trigger", "the row's real id must survive the projection, not be dropped");
  assert.notEqual(result[0]?.id, result[0]?.trigger, "id and trigger are DIFFERENT fields — this pins the caller cannot mistake one for the other");
});

test("retrieve() narrows a candidate rule's status verbatim (not coerced to active)", async () => {
  const rule: LearningRule = {
    id: "r2", trigger: "flaky wait", action: "use expect.poll", errorClass: "E-FLAKY",
    archetype: null, status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
    oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "run-2", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.equal(result[0]?.status, "candidate");
});

test("retrieve() with the StubLearningRepository (v1 default) returns [] — provably off-path", async () => {
  const adapter = new LearningPortAdapter(new StubLearningRepository(), "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result, []);
});

/* retrieve() must increment usage on exactly the retrieved set.
 */

test("retrieve() calls LearningRepositoryPort.incrementUsage with the retrieved rule ids", async () => {
  const rule: LearningRule = {
    id: "r3", trigger: "no aria label", action: "add role+name", errorClass: "E-EXEC-FAIL",
    archetype: null, status: "active", confidence: "medium", usageCount: 1, outcomeCount: 1,
    oracleOutcomeCount: 1, successRate: 0.8, lastVerified: null, source: "run-3", at: new Date().toISOString(),
  };
  let incrementedIds: readonly string[] | undefined;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
    incrementUsage: async (ids) => { incrementedIds = ids; },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(incrementedIds, ["r3"]);
});

test("retrieve() never calls incrementUsage when nothing was retrieved (no phantom usage)", async () => {
  let incrementCalled = false;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [],
    applyOutcome: async () => {},
    incrementUsage: async () => { incrementCalled = true; },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await adapter.retrieve(Sha.of("abc1234"));

  assert.equal(incrementCalled, false);
});

/* write failure must NEVER discard the already-successful topRules() retrieval. Mirrors fold()'s
   own documented off-path contract on this SAME port.
 */

test("retrieve() still returns the retrieved rules when incrementUsage REJECTS, and logs a warning (isolated, off-path)", async () => {
  const rule: LearningRule = {
    id: "r5", trigger: "missing alt text", action: "add alt attribute", errorClass: "E-EXEC-FAIL",
    archetype: null, status: "active", confidence: "high", usageCount: 2, outcomeCount: 2,
    oracleOutcomeCount: 2, successRate: 1, lastVerified: null, source: "run-5", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
    incrementUsage: async () => { throw new Error("telemetry store unreachable"); },
  };
  let warned: unknown;
  const adapter = new LearningPortAdapter(repo, "app", 20, undefined, (err) => { warned = err; });

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result, [{
    id: "r5",
    trigger: "missing alt text",
    action: "add alt attribute",
    errorClass: "E-EXEC-FAIL",
    status: "active",
    confidence: "high",
  }], "the already-successful topRules() retrieval must survive an incrementUsage failure");
  assert.ok(warned instanceof Error && warned.message === "telemetry store unreachable", "the incrementUsage failure must be logged, not silently dropped");
});

test("retrieve() with a rejecting incrementUsage does NOT reject the caller's own promise", async () => {
  const rule: LearningRule = {
    id: "r6", trigger: "t", action: "a", errorClass: "E-X", archetype: null, status: "candidate",
    confidence: "low", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null, lastVerified: null,
    source: "run-6", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
    incrementUsage: async () => { throw new Error("boom"); },
  };
  const adapter = new LearningPortAdapter(repo, "app", 20, undefined, () => {});

  await assert.doesNotReject(() => adapter.retrieve(Sha.of("abc1234")));
});

/* Retrieve applies a char-budget step, not only the count limit (DEFAULT_RETRIEVE_LIMIT). An
   oversized rule set must not reach the generator prompt uncapped. Budget-fit happens BEFORE
   recording usage, so usageCount/retrieved-ids reflect EXACTLY what the generator sees — no
   phantom "used" rules truncated out of the render.
 */

function makeRule(id: string, trigger: string, action: string): LearningRule {
  return {
    id, trigger, action, errorClass: "E-EXEC-FAIL", archetype: null, status: "active",
    confidence: "high", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null,
    lastVerified: null, source: "run", at: new Date().toISOString(),
  };
}

test("retrieve() drops the lowest-ranked (tail) rules until the rendered prompt section fits the char budget", async () => {
  /* topRules() returns rules already ranked best-first (RuleGovernanceService's own contract) —
     r1 is the highest-ranked, r3 the lowest.
   */
  const rules: LearningRule[] = [
    makeRule("r1", "trigger one padded to a realistic length for a rule description", "action one padded to a realistic length for a rule fix"),
    makeRule("r2", "trigger two padded to a realistic length for a rule description", "action two padded to a realistic length for a rule fix"),
    makeRule("r3", "trigger three padded to a realistic length for a rule description", "action three padded to a realistic length for a rule fix"),
  ];
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async (_app, _sha, limit) => rules.slice(0, limit),
    applyOutcome: async () => {},
  };
  /* Budget fits exactly the first rule's rendered section, not all three — derived from the SAME
     render function the generation bridge actually uses, so the test is not fragile to header text.
   */
  const oneRuleBudget = renderLearnedRules([
    { id: "r1", trigger: rules[0]!.trigger, action: rules[0]!.action, errorClass: rules[0]!.errorClass, status: "active", confidence: "high" },
  ]).length;
  const adapter = new LearningPortAdapter(repo, "app", 20, undefined, undefined, oneRuleBudget);

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result.map((r) => r.id), ["r1"], "only the highest-ranked (head) rule fits the budget — lowest-ranked tail rules are dropped");
});

test("retrieve() calls incrementUsage with EXACTLY the budget-fitted set, never the phantom untrimmed set", async () => {
  const rules: LearningRule[] = [
    makeRule("r1", "trigger one padded to a realistic length for a rule description", "action one padded to a realistic length for a rule fix"),
    makeRule("r2", "trigger two padded to a realistic length for a rule description", "action two padded to a realistic length for a rule fix"),
  ];
  let incrementedIds: readonly string[] | undefined;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async (_app, _sha, limit) => rules.slice(0, limit),
    applyOutcome: async () => {},
    incrementUsage: async (ids) => { incrementedIds = ids; },
  };
  const oneRuleBudget = renderLearnedRules([
    { id: "r1", trigger: rules[0]!.trigger, action: rules[0]!.action, errorClass: rules[0]!.errorClass, status: "active", confidence: "high" },
  ]).length;
  const adapter = new LearningPortAdapter(repo, "app", 20, undefined, undefined, oneRuleBudget);

  await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(incrementedIds, ["r1"], "usage must be recorded on exactly what the generator will see — never a rule truncated out of the render");
});

/* A repository that returns more rules than asked must not keep the budget fit re-asking forever.
   The fake is fused: past a generous bound it throws, so a fit that never converges fails this test
   instead of hanging the file (an async loop over resolved promises never lets a timer fire). */
test("retrieve() fits the budget and stops even when the repository ignores the requested limit", async () => {
  const rules: LearningRule[] = [
    makeRule("r1", "trigger one padded to a realistic length for a rule description", "action one padded to a realistic length for a rule fix"),
    makeRule("r2", "trigger two padded to a realistic length for a rule description", "action two padded to a realistic length for a rule fix"),
    makeRule("r3", "trigger three padded to a realistic length for a rule description", "action three padded to a realistic length for a rule fix"),
  ];
  let asked = 0;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => {
      asked += 1;
      if (asked > 100) throw new Error("retrieve() kept re-asking the repository without converging");
      return rules;
    },
    applyOutcome: async () => {},
  };
  const oneRuleBudget = renderLearnedRules([
    { id: "r1", trigger: rules[0]!.trigger, action: rules[0]!.action, errorClass: rules[0]!.errorClass, status: "active", confidence: "high" },
  ]).length;
  const adapter = new LearningPortAdapter(repo, "app", 20, undefined, undefined, oneRuleBudget);

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result.map((r) => r.id), ["r1"]);
});

test("retrieve() with a generously large budget returns every retrieved rule unchanged (no truncation when it already fits)", async () => {
  const rule = makeRule("r1", "short trigger", "short action");
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result.map((r) => r.id), ["r1"], "a rule set that already fits the default budget must not be trimmed");
});

/* R4: retrieve()'s optional relevance bias must reach LearningRepositoryPort.topRules verbatim —
   this is the wiring that was missing: RuleGovernanceService.topRules' errorClass/archetype bias
   (rule-governance.service.ts) existed but production never fed it anything, because retrieve()
   itself had no parameter to carry it through.
 */
test("retrieve() forwards an optional relevance bias to LearningRepositoryPort.topRules verbatim", async () => {
  let capturedRelevance: RelevanceBias | undefined;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async (_app, _sha, _limit, relevance) => { capturedRelevance = relevance; return []; },
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");
  const bias: RelevanceBias = { errorClass: "E-EXEC-FAIL", archetypes: ["api-call", "auth-flow"] };

  await adapter.retrieve(Sha.of("abc1234"), bias);

  assert.deepEqual(capturedRelevance, bias);
});

test("retrieve() called with no relevance bias forwards undefined to topRules (backward compatible — no fabricated bias)", async () => {
  let capturedRelevance: RelevanceBias | undefined = { errorClass: "should-be-overwritten" };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async (_app, _sha, _limit, relevance) => { capturedRelevance = relevance; return []; },
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await adapter.retrieve(Sha.of("abc1234"));

  assert.equal(capturedRelevance, undefined);
});

test("retrieve() tolerates a store without incrementUsage wired (optional method, off-path)", async () => {
  const rule: LearningRule = {
    id: "r4", trigger: "t", action: "a", errorClass: "E-X", archetype: null, status: "active",
    confidence: "low", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null, lastVerified: null,
    source: "run-4", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await assert.doesNotReject(() => adapter.retrieve(Sha.of("abc1234")));
});

/* Governance reserves the last retrieval slots for the freshest unproven candidates so they can earn
   (or be denied) promotion. The char budget must not silently cancel that reservation: when proven
   rules alone overflow the budget, the retrieved set is still what governance would pick at a count
   that fits — proven rules first, exploration candidates kept. Real SqliteLearningRepository and
   RuleGovernanceService; only the persistence store is an in-memory fake. */
function ledgerRow(id: string, status: "active" | "candidate", successRate: number | null, at: string): LearningRow {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `step${i}`).join(" ");
  return {
    id, trigger_text: `Applies when ${id} changes a form with async validation ${words(20)}`,
    action_text: `Assert the visible validation message for ${id} using getByRole ${words(24)}`,
    error_class: "E-FRAGILE-SELECTOR", archetype: null, status, confidence: "medium", usage_count: 0,
    outcome_count: 3, oracle_outcome_count: 1, success_rate: successRate, last_verified: null, source: "run", at,
  };
}

async function retrieveFromVerboseLedger() {
  const rows = [
    ...Array.from({ length: 22 }, (_, i) => ledgerRow(`active-${String(i).padStart(2, "0")}`, "active", 0.95 - i * 0.01, "2026-01-01T00:00:00.000Z")),
    ...Array.from({ length: 6 }, (_, i) => ledgerRow(`candidate-${i}`, "candidate", null, `2026-09-0${i + 1}T00:00:00.000Z`)),
  ];
  const usageRecorded: string[] = [];
  const store: LearningStore = {
    selectRules: () => rows,
    upsert: () => {},
    recordOutcome: () => {},
    incrementUsage: (ids) => { usageRecorded.push(...ids); },
  };
  const repo = new SqliteLearningRepository(store);
  const unfitted = await repo.topRules("app", Sha.of("abc1234"), 20);
  const retrieved = await new LearningPortAdapter(repo, "app").retrieve(Sha.of("abc1234"));
  return { unfitted, retrieved, usageRecorded };
}

test("retrieve(): a budget overflow by proven rules still keeps an exploration candidate and records its usage", async () => {
  const { unfitted, retrieved, usageRecorded } = await retrieveFromVerboseLedger();
  const toRendered = (r: LearningRule) => ({ id: r.id, trigger: r.trigger, action: r.action, errorClass: r.errorClass, status: r.status as "active" | "candidate", confidence: r.confidence });
  assert.ok(renderLearnedRules(unfitted.map(toRendered)).length > DEFAULT_RULES_CHAR_BUDGET, "setup check: the unfitted retrieval overflows the budget");

  const candidates = retrieved.filter((r) => r.status === "candidate").map((r) => r.id);
  assert.ok(candidates.length > 0, `an exploration candidate must survive budget fitting, got ${JSON.stringify(retrieved.map((r) => r.id))}`);
  for (const id of candidates) assert.ok(usageRecorded.includes(id), `usage must be recorded for the retrieved candidate ${id}`);
});

test("retrieve(): budget fitting keeps the best-proven rule and the retrieved set fits the budget", async () => {
  const { retrieved } = await retrieveFromVerboseLedger();

  assert.ok(retrieved.some((r) => r.id === "active-00"), "the highest-ranked proven rule must not be sacrificed for exploration");
  assert.ok(renderLearnedRules(retrieved).length <= DEFAULT_RULES_CHAR_BUDGET);
});
