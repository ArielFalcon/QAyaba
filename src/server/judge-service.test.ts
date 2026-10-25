import { test } from "node:test";
import assert from "node:assert/strict";
import { createJudgeService, type JudgeServiceDeps } from "./judge-service";
import { JUDGE_NAMES } from "@contexts/evaluation/domain/judges";
import type { JudgeBatchResult, JudgeWorkItem } from "@contexts/evaluation/application/run-judges.use-case";
import type { CalibrationReport } from "@contexts/evaluation/domain/judge-calibration";

type IdleJob = (signal: AbortSignal, shouldYield: () => boolean) => Promise<void>;

function fixture(over: Partial<JudgeServiceDeps> = {}, executed: Array<{ work: JudgeWorkItem[]; force: boolean }> = [], results: JudgeBatchResult[] = []) {
  const idle: IdleJob[] = [];
  const logs: string[] = [];
  let yieldNow = false;
  const deps: JudgeServiceDeps = {
    queue: { enqueueIdle: (job) => void idle.push(job) },
    switch: { enabled: true, dailyTokens: 1000 },
    setup: { ok: true, promptVersion: "1", configuredModel: "p/judge" },
    agentAvailable: async () => true,
    runner: {
      execute: async (work, opts) => {
        executed.push({ work: [...work], force: opts?.force === true });
        return results.shift() ?? { scored: work.length, unparseable: 0, notApplicable: 0, errors: 0, skipped: 0, remaining: [] };
      },
    },
    isCampaignRun: (id) => id.startsWith("camp-"),
    runIsFinished: (id) => !id.startsWith("live-"),
    calibrations: { latest: () => undefined, save: () => undefined },
    latestModel: () => undefined,
    log: (m) => logs.push(m),
    ...over,
  };
  const service = createJudgeService(deps);
  const flush = async (): Promise<void> => {
    while (idle.length > 0) await idle.shift()!(new AbortController().signal, () => yieldNow);
  };
  return { service, idle, logs, flush, setYield: (v: boolean) => (yieldNow = v) };
}

test("a finished campaign run is handed to every judge as one low-priority job", async () => {
  const executed: Array<{ work: JudgeWorkItem[]; force: boolean }> = [];
  const { service, idle, flush } = fixture({}, executed);
  service.scheduleForRun("camp-1");
  assert.equal(idle.length, 1, "queued as idle work, not run inline");
  assert.equal(executed.length, 0);
  await flush();
  assert.deepEqual(executed[0]?.work.map((w) => [w.runId, w.judge]), JUDGE_NAMES.map((judge) => ["camp-1", judge]));
  assert.equal(executed[0]?.force, false);
});

test("an ordinary run is not judged", () => {
  const { service, idle } = fixture();
  service.scheduleForRun("plain-1");
  assert.equal(idle.length, 0);
});

test("with the switch off nothing is ever queued, and an explicit request says why it cannot be taken", () => {
  const { service, idle } = fixture({ switch: { enabled: false, dailyTokens: 1000 } });
  service.scheduleForRun("camp-1");
  assert.equal(idle.length, 0);
  assert.match(service.unavailable() ?? "", /QA_JUDGES_ENABLED/);
  assert.equal(service.request("camp-1", ["spec_relevance"]), "unavailable-run");
  assert.equal(idle.length, 0);
});

test("a setup that is refused keeps the judges inactive and the reason is the one reported", () => {
  const { service, idle } = fixture({ setup: { ok: false, reason: "the qa-judge model is the generator's own" } });
  service.scheduleForRun("camp-1");
  assert.equal(idle.length, 0);
  assert.match(service.unavailable() ?? "", /generator's own/);
});

test("when the live agent list does not hold the judge role the job refuses to run and says so", async () => {
  const executed: Array<{ work: JudgeWorkItem[]; force: boolean }> = [];
  const { service, flush, logs } = fixture({ agentAvailable: async () => false }, executed);
  service.scheduleForRun("camp-1");
  await flush();
  assert.equal(executed.length, 0);
  assert.ok(logs.some((l) => l.includes("qa-judge")));
});

test("a failing availability check refuses the job the same way, and never throws out of the queue", async () => {
  const { service, flush, logs } = fixture({ agentAvailable: async () => { throw new Error("agent list unreachable"); } });
  service.scheduleForRun("camp-1");
  await flush();
  assert.ok(logs.some((l) => l.includes("agent list unreachable")));
});

test("an explicit request is forced, covers only the judges named, and an unfinished run is refused", async () => {
  const executed: Array<{ work: JudgeWorkItem[]; force: boolean }> = [];
  const { service, flush } = fixture({}, executed);
  assert.equal(service.request("live-1", ["spec_relevance"]), "unavailable-run");
  assert.equal(service.request("camp-2", ["failure_root_cause"]), "scheduled");
  await flush();
  assert.deepEqual(executed[0]?.work, [{ runId: "camp-2", judge: "failure_root_cause" }]);
  assert.equal(executed[0]?.force, true);
});

test("many requests become one queued job, and the same pair twice is judged once", async () => {
  const executed: Array<{ work: JudgeWorkItem[]; force: boolean }> = [];
  const { service, idle, flush } = fixture({}, executed);
  service.scheduleForRun("camp-1");
  service.scheduleForRun("camp-1");
  service.scheduleForRun("camp-2");
  assert.equal(idle.length, 1);
  await flush();
  assert.equal(executed.flatMap((e) => e.work).length, 2 * JUDGE_NAMES.length);
});

test("a batch that yields to a waiting run queues the rest again behind it", async () => {
  const executed: Array<{ work: JudgeWorkItem[]; force: boolean }> = [];
  const left: JudgeWorkItem[] = [{ runId: "camp-2", judge: "spec_relevance" }];
  const { service, idle } = fixture({}, executed, [{ scored: 1, unparseable: 0, notApplicable: 0, errors: 0, skipped: 0, stopped: "yield", remaining: left }]);
  service.scheduleForRun("camp-1");
  await idle.shift()!(new AbortController().signal, () => true);
  assert.equal(idle.length, 1, "the remainder is a new idle job");
  await idle.shift()!(new AbortController().signal, () => false);
  assert.deepEqual(executed[1]?.work, left);
});

test("a batch stopped by the daily budget drops what is left and says so, instead of retrying forever", async () => {
  const executed: Array<{ work: JudgeWorkItem[]; force: boolean }> = [];
  const { service, idle, logs } = fixture({}, executed, [{ scored: 0, unparseable: 0, notApplicable: 0, errors: 0, skipped: 0, stopped: "budget", remaining: [{ runId: "camp-1", judge: "spec_relevance" }] }]);
  service.scheduleForRun("camp-1");
  await idle.shift()!(new AbortController().signal, () => false);
  assert.equal(idle.length, 0);
  assert.ok(logs.some((l) => /budget/.test(l)));
});

function report(over: Partial<CalibrationReport>): CalibrationReport {
  return { judge: "spec_relevance", promptVersion: "1", model: "p/judge", splits: { train: { n: 0 }, dev: { n: 0 }, test: { n: 0 } }, tpr: 1, tnr: 1, agreement: 1, classCounts: {}, thresholds: { minTpr: 0.8, minTnr: 0.8, minN: 20 }, status: "calibrated", reasons: [], computedAt: "2026-10-18T00:00:00.000Z", ...over };
}

test("a judge is calibrated only by a calibrated report of the prompt in force for the model that is answering now", () => {
  const calibrated = (over: Partial<JudgeServiceDeps> = {}) => fixture({ calibrations: { latest: (_j, v) => (v === "1" ? report({}) : undefined), save: () => undefined }, latestModel: () => "p/judge", ...over }).service.statusOf("spec_relevance");
  assert.equal(calibrated(), "calibrated");
  assert.equal(calibrated({ latestModel: () => "p/other" }), "experimental", "the model changed after the calibration");
  assert.equal(calibrated({ setup: { ok: true, promptVersion: "2", configuredModel: "p/judge" } }), "experimental", "the prompt changed after the calibration");
  assert.equal(fixture({ calibrations: { latest: () => report({ status: "experimental" }), save: () => undefined } }).service.statusOf("spec_relevance"), "experimental");
  assert.equal(fixture().service.statusOf("spec_relevance"), "experimental", "no calibration is the default");
});

test("a judge with no usable setup is experimental whatever was calibrated", () => {
  const { service } = fixture({ setup: { ok: false, reason: "x" }, calibrations: { latest: () => report({}), save: () => undefined } });
  assert.equal(service.statusOf("spec_relevance"), "experimental");
  assert.equal(service.promptVersion(), undefined);
});

test("a calibration made with a lowered bar never makes the catalog say calibrated", () => {
  const lax = report({ thresholds: { minTpr: 0.8, minTnr: 0.8, minN: 1 } });
  const { service } = fixture({ calibrations: { latest: () => lax, save: () => undefined }, latestModel: () => "p/judge" });
  assert.equal(service.statusOf("spec_relevance"), "experimental");
});

test("an availability check that never answers refuses the job instead of holding the queue", async () => {
  const { service, flush, logs } = fixture({ agentAvailable: () => new Promise<boolean>(() => undefined), availabilityTimeoutMs: 5 });
  service.scheduleForRun("camp-1");
  await flush();
  assert.ok(logs.some((l) => l.includes("timed out")));
});

test("a batch aborted by a waiting run queues what is left again instead of dropping it", async () => {
  const left: JudgeWorkItem[] = [{ runId: "camp-1", judge: "spec_relevance" }];
  const { service, idle } = fixture({}, [], [{ scored: 0, unparseable: 0, notApplicable: 0, errors: 0, skipped: 0, stopped: "aborted", remaining: left }]);
  service.scheduleForRun("camp-1");
  await idle.shift()!(new AbortController().signal, () => false);
  assert.equal(idle.length, 1);
});
