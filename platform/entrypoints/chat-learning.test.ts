/*
 * What the assistant is told about the app a run belongs to and about the product, over the real history store (test-setup.mjs gives
 * each test file a temporary one): the context the API hands the assistant, read at the use case's seam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerHelp, askAboutRun } from "./api/use-cases/ask";
import type { ApiDeps } from "./api/deps";
import { getHistory } from "../persistence/index";
import { DEFAULT_HOST } from "../settings/port";
import type { RunRecord } from "../persistence/types";

const record = (app: string): RunRecord => ({ id: `${app}-run`, app, sha: "abcdef1234567890", target: "e2e", mode: "diff", status: "done", verdict: "fail", cases: [], logs: [], at: "t" });

async function contextOf(app: string): Promise<string> {
  let context = "";
  const deps = {
    getRecord: () => record(app),
    loadApp: () => { throw new Error("not configured"); },
    ask: async (input: { context: string }) => { context = input.context; return "answer"; },
  } as unknown as ApiDeps;
  await askAboutRun(deps, `${app}-run`, async () => ({ question: "why?" }));
  return context;
}

test("the assistant is told the recent outcomes an app's runs left", async () => {
  const app = `chat-outcomes-${Math.random().toString(36).slice(2)}`;
  getHistory().learning.saveRunOutcome({
    runId: `${app}-1`, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict: "fail", errorClass: "E-EXEC-FAIL",
    gateSignals: { static: true, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0 }, at: "2026-10-01T00:00:00.000Z",
  });

  const context = await contextOf(app);

  assert.match(context, /fail E-EXEC-FAIL \(diff\/e2e, abcdef1\)/);
});

test("an app with no outcome at all gives the assistant no outcomes block", async () => {
  assert.doesNotMatch(await contextOf(`chat-empty-${Math.random().toString(36).slice(2)}`), /Recent outcomes/);
});

test("the help assistant tells operators the default address the service listens on", async () => {
  let context = "";
  const deps = { ask: async (input: { context: string }) => { context = input.context; return "answer"; } } as unknown as ApiDeps;
  await answerHelp(deps, async () => ({ question: "where is the service?" }));
  assert.ok(context.includes(DEFAULT_HOST));
});
