/* FoldRunOutcome: which retrieved rules a run's outcome is credited to, with which score, and that a failing ledger never fails the run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FoldRunOutcome, type LearningStore } from "@contexts/cross-run-learning/application/index.ts";
import { PREVENTION_HELD_SCORE } from "@contexts/cross-run-learning/domain/rule-fold.ts";
import type { LearningRule } from "@contexts/cross-run-learning/domain/learning-repository.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

function rule(id: string, over: Partial<LearningRule> = {}): LearningRule {
  return { id, trigger: "t", action: "a", errorClass: "E-SELECTOR", archetype: null, status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "s", at: "2026-01-01T00:00:00.000Z", ...over } as LearningRule;
}

function outcome(over: Partial<RunOutcome> & { gate?: Partial<RunOutcome["gateSignals"]> } = {}): RunOutcome {
  const { gate, ...rest } = over;
  return {
    runId: "run-1", app: "app", sha: "abc1234", mode: "diff", target: "e2e", verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, ...gate },
    rulesRetrieved: [], at: "2026-01-01T00:00:00.000Z", ...rest,
  } as RunOutcome;
}

function ledger(rules: LearningRule[] = []) {
  const scorecards: unknown[] = [];
  const folds: { id: string; score: number; coverage: boolean | null; oracle: boolean | undefined }[] = [];
  const store: LearningStore = {
    selectRules: () => [],
    upsert: () => {},
    saveScorecardEntry: (entry) => void scorecards.push(entry),
    findRule: (id) => rules.find((r) => r.id === id),
    recordRuleOutcome: (id, score, coverage, oracle) => void folds.push({ id, score, coverage, oracle }),
  };
  return { store, scorecards, folds };
}

test("an outcome with no retrieved rule still saves the scorecard, with unmeasured counts as null", () => {
  const { store, scorecards, folds } = ledger();

  new FoldRunOutcome(store).execute(outcome({ gate: { valueScore: 0.5 } }));

  assert.deepEqual(scorecards, [{ runId: "run-1", app: "app", sha: "abc1234", target: "e2e", valueScore: 0.5, mutantCount: null, killedCount: null, at: "2026-01-01T00:00:00.000Z" }]);
  assert.deepEqual(folds, []);
});

test("the oracle score is folded onto every attributable retrieved rule as an oracle score, with the coverage credit", () => {
  const { store, folds } = ledger([rule("r1"), rule("r2")]);

  new FoldRunOutcome(store).execute(outcome({ rulesRetrieved: ["r1", "r2"], gate: { valueScore: 0.8, coverageRatio: 0.4, mutantCount: 5, killedCount: 4 } }));

  assert.deepEqual(folds, [
    { id: "r1", score: 0.8, coverage: true, oracle: true },
    { id: "r2", score: 0.8, coverage: true, oracle: true },
  ]);
});

test("coverage measured at zero withholds the credit, and unmeasured coverage leaves it unknown", () => {
  const zero = ledger([rule("r1")]);
  new FoldRunOutcome(zero.store).execute(outcome({ rulesRetrieved: ["r1"], gate: { valueScore: 0.8, coverageRatio: 0 } }));
  const unknown = ledger([rule("r1")]);
  new FoldRunOutcome(unknown.store).execute(outcome({ rulesRetrieved: ["r1"], gate: { valueScore: 0.8 } }));

  assert.equal(zero.folds[0]!.coverage, false);
  assert.equal(unknown.folds[0]!.coverage, null);
});

test("without an oracle score a rule is credited by prevention: held when the run met no error, zero when its own class recurred, nothing for infra", () => {
  const held = ledger([rule("r1")]);
  new FoldRunOutcome(held.store).execute(outcome({ rulesRetrieved: ["r1"] }));
  const recurred = ledger([rule("r1")]);
  new FoldRunOutcome(recurred.store).execute(outcome({ rulesRetrieved: ["r1"], errorClass: "E-SELECTOR" as never }));
  const infra = ledger([rule("r1")]);
  new FoldRunOutcome(infra.store).execute(outcome({ rulesRetrieved: ["r1"], errorClass: "E-INFRA" as never }));

  assert.deepEqual(held.folds, [{ id: "r1", score: PREVENTION_HELD_SCORE, coverage: null, oracle: undefined }]);
  assert.deepEqual(recurred.folds, [{ id: "r1", score: 0, coverage: null, oracle: undefined }]);
  assert.deepEqual(infra.folds, []);
});

test("a rule the ledger no longer holds carries no signal", () => {
  const { store, folds } = ledger([rule("kept")]);

  new FoldRunOutcome(store).execute(outcome({ rulesRetrieved: ["gone", "kept"], gate: { valueScore: 1 } }));

  assert.deepEqual(folds.map((f) => f.id), ["kept"]);
});

test("a rule tagged with another kind of change is not credited when the diff's shapes are known", () => {
  const { store, folds } = ledger([rule("tagged", { archetype: "form-validation" }), rule("untagged")]);

  new FoldRunOutcome(store).execute(outcome({ rulesRetrieved: ["tagged", "untagged"], diffArchetypes: ["table-listing"], gate: { valueScore: 1 } }));

  assert.deepEqual(folds.map((f) => f.id), ["untagged"]);
});

test("a failing ledger is swallowed and logged, and the fold never throws into the run", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  try {
    const { store } = ledger();
    store.saveScorecardEntry = () => {
      throw new Error("disk full");
    };

    assert.doesNotThrow(() => new FoldRunOutcome(store).execute(outcome()));
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /disk full/);
});
