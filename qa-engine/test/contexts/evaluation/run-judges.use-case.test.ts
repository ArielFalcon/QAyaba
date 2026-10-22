import { test } from "node:test";
import assert from "node:assert/strict";
import { RunJudgesUseCase, type RunJudgesDeps } from "@contexts/evaluation/application/run-judges.use-case.ts";
import { judgeGraderVersion } from "@contexts/evaluation/domain/judges.ts";
import { MemoryScoreStore } from "./fakes.ts";
import { MemoryEvidence, MemoryLedger, ScriptedJudge, judgeEvidence, verdict } from "./judge-fakes.ts";

const NOW = "2026-10-18T10:00:00.000Z";

function setup(over: { evidence?: ConstructorParameters<typeof MemoryEvidence>[0]; answers?: ConstructorParameters<typeof ScriptedJudge>[0]; budget?: number; model?: string } = {}) {
  const store = new MemoryScoreStore();
  const ledger = new MemoryLedger();
  const agent = new ScriptedJudge(over.answers ?? []);
  const logs: string[] = [];
  const deps: RunJudgesDeps = {
    evidence: new MemoryEvidence(over.evidence ?? { "run-1": judgeEvidence() }),
    agent,
    store,
    ledger,
    promptVersion: "1",
    ...(over.model !== undefined ? { configuredModel: over.model } : {}),
    dailyTokenBudget: over.budget ?? 1_000_000,
    sanitize: (t) => t,
    now: () => NOW,
    log: (m) => logs.push(m),
  };
  return { uc: new RunJudgesUseCase(deps), store, ledger, agent, logs };
}

test("a judgeable run gets an llm_judge score carrying the judge, the prompt version, the model and the critique", async () => {
  const { uc, store, ledger } = setup({ answers: [{ output: verdict("pass", "opens the changed page"), tokens: 1200, model: "p/answering-model" }] });
  const result = await uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.equal(result.scored, 1);
  const stored = store.list("run-1", { allVersions: true });
  assert.equal(stored.length, 1);
  const score = stored[0]!;
  assert.equal(score.source, "llm_judge");
  assert.equal(score.value, true);
  assert.equal(score.graderVersion, judgeGraderVersion("spec_relevance", "1"));
  assert.equal(score.judgeModel, "p/answering-model");
  assert.equal(score.comment, "opens the changed page");
  assert.deepEqual([ledger.attempts[0]?.outcome, ledger.attempts[0]?.tokens], ["scored", 1200]);
});

test("the model that answered wins over the configured one, which wins over nothing", async () => {
  const answered = setup({ model: "p/configured", answers: [{ output: verdict("pass"), tokens: 1, model: "p/answered" }] });
  await answered.uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.equal(answered.store.list("run-1", { allVersions: true })[0]?.judgeModel, "p/answered");
  const configured = setup({ model: "p/configured", answers: [{ output: verdict("pass"), tokens: 1, model: undefined }] });
  await configured.uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.equal(configured.store.list("run-1", { allVersions: true })[0]?.judgeModel, "p/configured");
  const neither = setup({ answers: [{ output: verdict("pass"), tokens: 1, model: undefined }] });
  await neither.uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.equal(neither.store.list("run-1", { allVersions: true })[0]?.judgeModel, "unknown");
});

test("an unparseable reply produces no score, is counted and is remembered, and the batch goes on", async () => {
  const { uc, store, ledger } = setup({
    evidence: { "run-1": judgeEvidence(), "run-2": judgeEvidence({ runId: "run-2" }) },
    answers: [{ output: "I think it is relevant", tokens: 500, model: "m" }, { output: verdict("fail"), tokens: 500, model: "m" }],
  });
  const result = await uc.execute([{ runId: "run-1", judge: "spec_relevance" }, { runId: "run-2", judge: "spec_relevance" }]);
  assert.deepEqual([result.scored, result.unparseable], [1, 1]);
  assert.equal(store.list("run-1", { allVersions: true }).length, 0);
  assert.equal(ledger.lastOutcome("run-1", "spec_relevance", "1"), "unparseable");
  assert.equal(ledger.attempts.find((a) => a.runId === "run-1")?.tokens, 500, "a reply that scored nothing still spent the budget");
});

test("a run the judge cannot grade is not sent to the model and is remembered as not applicable", async () => {
  const { uc, agent, ledger } = setup({ evidence: { "run-1": judgeEvidence({ diff: undefined }) } });
  const result = await uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.equal(result.notApplicable, 1);
  assert.equal(agent.asked.length, 0);
  assert.equal(ledger.lastOutcome("run-1", "spec_relevance", "1"), "not_applicable");
});

test("an unknown run is not applicable and a throwing agent is an error that does not stop the next item", async () => {
  const { uc, ledger } = setup({
    evidence: { "run-2": judgeEvidence({ runId: "run-2" }), "run-3": judgeEvidence({ runId: "run-3" }) },
    answers: [new Error("provider 529"), { output: verdict("pass"), tokens: 10, model: "m" }],
  });
  const result = await uc.execute([
    { runId: "ghost", judge: "spec_relevance" },
    { runId: "run-2", judge: "spec_relevance" },
    { runId: "run-3", judge: "spec_relevance" },
  ]);
  assert.deepEqual([result.notApplicable, result.errors, result.scored], [1, 1, 1]);
  assert.equal(ledger.lastOutcome("run-2", "spec_relevance", "1"), "error");
  assert.equal(ledger.lastOutcome("ghost", "spec_relevance", "1"), undefined, "a run that is not there is not remembered as judged");
});

test("a pair already scored or answered unparseably at this prompt version is not asked again, unless forced; an error is retried", async () => {
  const { uc, agent, ledger } = setup({ answers: [{ output: verdict("pass"), tokens: 10, model: "m" }, { output: verdict("fail"), tokens: 10, model: "m" }, { output: verdict("pass"), tokens: 10, model: "m" }] });
  const work = [{ runId: "run-1", judge: "spec_relevance" as const }];
  await uc.execute(work);
  const again = await uc.execute(work);
  assert.equal(again.skipped, 1);
  assert.equal(agent.asked.length, 1);
  const forced = await uc.execute(work, { force: true });
  assert.equal(forced.scored, 1);
  assert.equal(agent.asked.length, 2);
  ledger.record({ runId: "run-1", judge: "failure_root_cause", promptVersion: "1", model: null, outcome: "error", tokens: 0, detail: "x", at: NOW });
  await uc.execute([{ runId: "run-1", judge: "failure_root_cause" }]);
  assert.equal(agent.asked.length, 3, "an error is retried");
});

test("a new prompt version is a new question: the same pair is judged again", async () => {
  const first = setup({ answers: [{ output: verdict("pass"), tokens: 10, model: "m" }] });
  await first.uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  const second = new RunJudgesUseCase({
    evidence: new MemoryEvidence({ "run-1": judgeEvidence() }),
    agent: new ScriptedJudge([{ output: verdict("fail"), tokens: 10, model: "m" }]),
    store: first.store,
    ledger: first.ledger,
    promptVersion: "2",
    dailyTokenBudget: 1_000_000,
    sanitize: (t) => t,
    now: () => NOW,
  });
  assert.equal((await second.execute([{ runId: "run-1", judge: "spec_relevance" }])).scored, 1);
  assert.equal(first.store.list("run-1", { allVersions: true }).length, 2);
});

test("the daily token budget stops the batch before a call that would pass it and hands back what is left", async () => {
  const { uc, agent, ledger } = setup({
    evidence: { "run-1": judgeEvidence(), "run-2": judgeEvidence({ runId: "run-2" }) },
    answers: [{ output: verdict("pass"), tokens: 900, model: "m" }, { output: verdict("pass"), tokens: 900, model: "m" }],
    budget: 1_000,
  });
  ledger.record({ runId: "earlier", judge: "spec_relevance", promptVersion: "1", model: null, outcome: "scored", tokens: 0, detail: null, at: "2026-10-17T23:59:00.000Z" });
  const result = await uc.execute([{ runId: "run-1", judge: "spec_relevance" }, { runId: "run-2", judge: "spec_relevance" }]);
  assert.equal(result.stopped, "budget");
  assert.deepEqual(result.remaining, [{ runId: "run-2", judge: "spec_relevance" }]);
  assert.equal(agent.asked.length, 1);
});

test("yesterday's tokens do not count against today's budget", async () => {
  const { uc, ledger } = setup({ answers: [{ output: verdict("pass"), tokens: 10, model: "m" }], budget: 1_000_000 });
  ledger.record({ runId: "old", judge: "spec_relevance", promptVersion: "1", model: null, outcome: "scored", tokens: 999_999_999, detail: null, at: "2026-10-17T10:00:00.000Z" });
  assert.equal((await uc.execute([{ runId: "run-1", judge: "spec_relevance" }])).scored, 1);
});

test("a call is budgeted by an estimate of its prompt when the runtime reports no tokens", async () => {
  const { uc, ledger } = setup({ answers: [{ output: verdict("pass"), tokens: null, model: "m" }] });
  await uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.ok(ledger.attempts[0]!.tokens > 0, "an estimate is recorded, never zero");
});

test("the batch yields to a waiting run between two calls, and stops when aborted", async () => {
  const { uc, agent } = setup({
    evidence: { "run-1": judgeEvidence(), "run-2": judgeEvidence({ runId: "run-2" }) },
    answers: [{ output: verdict("pass"), tokens: 10, model: "m" }, { output: verdict("pass"), tokens: 10, model: "m" }],
  });
  const work = [{ runId: "run-1", judge: "spec_relevance" as const }, { runId: "run-2", judge: "spec_relevance" as const }];
  let checks = 0;
  /* Nothing waits before the first call; a run is waiting by the second. */
  const yielded = await uc.execute(work, { shouldYield: () => checks++ >= 1 });
  assert.equal(yielded.stopped, "yield");
  assert.deepEqual(yielded.remaining, [work[1]]);
  assert.equal(agent.asked.length, 1);

  const controller = new AbortController();
  controller.abort();
  const aborted = await uc.execute([work[1]!], { signal: controller.signal });
  assert.equal(aborted.stopped, "aborted");
  assert.equal(agent.asked.length, 1);
});

test("judging writes only its own score rows and never touches the run's evaluation status", async () => {
  const { uc, store } = setup({ answers: [{ output: verdict("pass"), tokens: 10, model: "m" }] });
  store.setStatus("run-1", "complete");
  await uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.equal(store.status("run-1"), "complete");
  assert.deepEqual(store.list("run-1", { allVersions: true }).map((s) => s.source), ["llm_judge"]);
});

test("a store that throws is an error for that pair, said in the log, and the batch goes on", async () => {
  const { uc, store, logs } = setup({
    evidence: { "run-1": judgeEvidence(), "run-2": judgeEvidence({ runId: "run-2" }) },
    answers: [{ output: verdict("pass"), tokens: 10, model: "m" }, { output: verdict("pass"), tokens: 10, model: "m" }],
  });
  let first = true;
  const original = store.replace.bind(store);
  store.replace = (runId, scores, gradedAt, scope) => {
    if (first) {
      first = false;
      throw new Error("disk full");
    }
    original(runId, scores, gradedAt, scope);
  };
  const result = await uc.execute([{ runId: "run-1", judge: "spec_relevance" }, { runId: "run-2", judge: "spec_relevance" }]);
  assert.deepEqual([result.errors, result.scored], [1, 1]);
  assert.ok(logs.some((l) => l.includes("disk full")));
});

test("a call cut by an abort is not an error: the item is handed back and nothing is recorded", async () => {
  const controller = new AbortController();
  const { uc, ledger } = setup({ answers: [new Error("aborted by a waiting run")] });
  controller.abort();
  const result = await uc.execute([{ runId: "run-1", judge: "spec_relevance" }], { signal: controller.signal, shouldYield: () => false });
  assert.equal(result.stopped, "aborted");
  assert.deepEqual(result.remaining, [{ runId: "run-1", judge: "spec_relevance" }]);
  assert.equal(ledger.attempts.length, 0);
});

test("a call that fails is still charged an estimate, so repeated timeouts cannot run past the day's budget", async () => {
  const { uc, ledger } = setup({ answers: [new Error("timed out")] });
  await uc.execute([{ runId: "run-1", judge: "spec_relevance" }]);
  assert.ok(ledger.attempts[0]!.tokens > 0);
});
