/* A limit only an agent turn met is listed with the run's limits and leads nothing: the record, the root span, the run view's budgets, the exhaustion counter and the budget_exhaustion grade read the limits the engine met at run level. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";
import { enqueueTrackedRun } from "./runner";
import { HistoryEvidenceAdapter, defaultEvidenceDeps } from "../persistence/evaluation-evidence";
import { gradeEvidence } from "@contexts/evaluation/application/index";
import type { RunPipelinePort } from "@contexts/run-orchestration/application/index.ts";
import type { RunOutcome } from "@kernel/run-outcome";
import { attachTraceFacts } from "@kernel/run-trace-facts";
import { traceHarness } from "../test-support/trace-harness";
import { getHistory } from "../persistence/index";
import { buildRunViewExtras, defaultRunViewDeps } from "./run-view";

test("a clean decided run with one repair-cap turn lists that limit and leads with none", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = "probe-app-" + Math.random().toString(36).slice(2, 7);
  const port: RunPipelinePort = {
    run: async (input) => {
      getHistory().telemetry.saveAgentTurn({ runId: input.runId, sessionId: "s1", role: "qa-author", round: 0, isRepair: true, ts: "2026-10-17T10:00:00.000Z", objective: null, promptText: "p", outputText: "", promptBytes: 1, tokensInput: 1, tokensOutput: 1, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: 0, ended: "timeout", durationMs: 120000, limitFired: "repair-cap" } as never);
      const outcome: RunOutcome = { runId: input.runId, app: input.app, sha: input.sha.value, mode: input.mode, target: input.target, verdict: "pass", errorClass: null, gateSignals: { static: true, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0, furthestPhase: "learn" } as never, at: new Date(0).toISOString() };
      return attachTraceFacts(outcome, { decision: "pr", shadowed: false, limits: [], endReason: "decided" } as never);
    },
  };
  const cfg = (name: string) => ({ name, repo: "org/demo", dev: { baseUrl: "https://dev" }, qa: { needsReview: false, testDataPrefix: "qa-bot", shadow: true }, report: { onFailure: "github-issue" } });
  const id = enqueueTrackedRun(queue, { app, sha: "abc1234", target: "e2e", mode: "diff", source: "manual", trigger: "api" } as never, { loadApp: cfg as never, engineFactory: () => port, telemetry: h.telemetry, clock: h.clock } as never);
  await queue.drain();
  const root = h.only("qayaba.run");
  const facts = getHistory().runs.getRunFacts(id) as Record<string, unknown>;
  const view = buildRunViewExtras(id, defaultRunViewDeps(() => true, {}));
  const evidence = (await new HistoryEvidenceAdapter(defaultEvidenceDeps).load(id))!;
  const grade = gradeEvidence(evidence).find((s) => s.name === "budget_exhaustion");
  const counter = h.measurements.filter((m) => m.name === "qayaba.budget.exhausted").map((m) => m.attrs);
  assert.deepEqual(facts.limits, [{ fired: "repair-cap", role: "qa-author", scope: "turn", turns: 1 }]);
  assert.equal(facts.limitFired ?? null, null);
  assert.equal(root.attributes["qayaba.limit.fired"], undefined);
  assert.deepEqual(root.attributes["qayaba.limits"], ["repair-cap@qa-author"]);
  assert.equal(view?.budgets.exhausted, false);
  assert.deepEqual(view?.budgets.limits, [{ fired: "repair-cap", role: "qa-author", scope: "turn", turns: 1 }]);
  assert.equal(grade?.value, "none");
  assert.deepEqual(counter, []);
});
