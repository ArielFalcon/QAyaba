/* A campaign replicate through the run funnel: what is stored, what the trace says, what the capture ceiling does, and that the labels reach nothing that decides. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";
import { enqueueTrackedRun, type RunnerDeps, type RunRequest } from "./runner";
import { getRecord, getRunCampaign, getStoredEffectiveConfig, listCampaignRuns } from "./history";
import { buildRunViewExtras, defaultRunViewDeps } from "./run-view";
import type { AppConfig } from "../orchestrator/config-loader";
import type { RunPipelinePort, RunInput } from "@contexts/run-orchestration/application/index.ts";
import type { RunOutcome } from "@kernel/run-outcome";
import type { CampaignIdentity } from "../contract/campaign";
import { traceHarness } from "../telemetry/trace-harness";
import { CampaignCaptureMismatchError } from "./campaign-capture";
import type { RunConfigEnvironment } from "./effective-config";
import { getHistory } from "./persistence/index";

const cfg = (name: string, qa: Record<string, unknown> = {}): AppConfig =>
  ({
    name,
    repo: "org/demo",
    dev: { baseUrl: "https://dev" },
    qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true, ...qa },
    report: { onFailure: "github-issue" },
  }) as AppConfig;

let counter = 0;
const uniqueApp = (): string => `camp-app-${(counter += 1)}-${Math.random().toString(36).slice(2, 7)}`;

function outcomeOf(input: RunInput): RunOutcome {
  return {
    runId: input.runId, app: input.app, sha: input.sha.value, mode: input.mode, target: input.target, verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: new Date(0).toISOString(),
  };
}

const env: RunConfigEnvironment = {
  runtime: () => "opencode",
  staticPromptHash: () => "sha256:feed",
  toolsGranted: true,
  reflectorEnabled: true,
  campaignFrozen: true,
  maxCapture: "metadata",
};

function request(app: string, extra: Partial<RunRequest> = {}): RunRequest {
  return { app, sha: "abc1234", target: "e2e", mode: "diff", source: "manual", trigger: "api", ...extra };
}

const campaign = (variant: Record<string, string>, replicate = 1): CampaignIdentity => ({ id: "ab-1", variant, replicate });

function deps(h: ReturnType<typeof traceHarness>, port: RunPipelinePort, over: Partial<RunnerDeps> = {}, app: AppConfig | ((n: string) => AppConfig) = cfg): RunnerDeps {
  return { loadApp: typeof app === "function" ? app : () => app, engineFactory: () => port, telemetry: h.telemetry, clock: h.clock, runConfig: env, ...over };
}

test("a campaign replicate is stored on the run with its labels, and the run view echoes them", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = uniqueApp();
  const id = enqueueTrackedRun(queue, request(app, { campaign: campaign({ arm: "treatment", model: "m.1" }, 3) }), deps(h, { run: async (i) => outcomeOf(i) }));
  await queue.drain();
  assert.deepEqual(getRunCampaign(id), { id: "ab-1", variant: { arm: "treatment", model: "m.1" }, replicate: 3 });
  const view = buildRunViewExtras(id, defaultRunViewDeps(() => true, {}))!;
  assert.deepEqual(view.campaign, { id: "ab-1", variant: { arm: "treatment", model: "m.1" }, replicate: 3 });
  assert.equal(listCampaignRuns("ab-1").some((r) => r.id === id), true);
});

test("an ordinary run has no campaign", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, { run: async (i) => outcomeOf(i) }));
  await queue.drain();
  assert.equal(getRunCampaign(id), undefined);
  assert.equal("campaign" in buildRunViewExtras(id, defaultRunViewDeps(() => true, {}))!, false);
});

test("the root span carries the campaign, groups the session by it, tags the variant values and the trigger is campaign", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  enqueueTrackedRun(queue, request(uniqueApp(), { campaign: campaign({ arm: "treatment", "model.name": "m1" }, 2) }), deps(h, { run: async (i) => outcomeOf(i) }));
  await queue.drain();
  const root = h.only("qayaba.run");
  assert.equal(root.attributes["qayaba.campaign.id"], "ab-1");
  assert.equal(root.attributes["qayaba.campaign.replicate"], 2);
  assert.equal(root.attributes["qayaba.campaign.variant.arm"], "treatment");
  assert.equal(root.attributes["qayaba.campaign.variant.model_name"], "m1");
  assert.equal(root.attributes["langfuse.session.id"], "ab-1");
  assert.deepEqual((root.attributes["langfuse.trace.tags"] as string[]).slice(1), ["diff", "treatment", "m1"]);
  assert.equal(root.attributes["qayaba.trigger"], "campaign");
});

test("variant labels never change what the engine is asked: two runs that differ only in labels see the same engine inputs", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = uniqueApp();
  const seen: Array<{ factoryArgs: string; input: Omit<RunInput, "runId"> | undefined }> = [];
  const capturing = (): RunnerDeps =>
    deps(h, { run: async (i) => outcomeOf(i) }, {
      engineFactory: (appConfig, namespace, run, _observer, previousNamespace) => {
        /* The run id is per-run identity, not a label-driven engine input: leave it out of the comparison. */
        const { runId: _runId, ...comparableRun } = run;
        const entry: (typeof seen)[number] = { factoryArgs: JSON.stringify({ appConfig, run: comparableRun, previousNamespace, namespace: namespace.replace(/-[a-z0-9]+-[0-9a-f]{8}$/, "") }), input: undefined };
        seen.push(entry);
        return { run: async (i) => { const { runId: _runId, ...rest } = i; entry.input = rest; return outcomeOf(i); } };
      },
    });
  enqueueTrackedRun(queue, request(app, { campaign: campaign({ arm: "control" }) }), capturing());
  await queue.drain();
  enqueueTrackedRun(queue, request(app, { campaign: campaign({ arm: "treatment", extra: "x", model: "other" }, 7) }), capturing());
  await queue.drain();
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.input);
  assert.deepEqual(seen[1]!.input, seen[0]!.input);
  assert.equal(seen[1]!.factoryArgs, seen[0]!.factoryArgs);
  assert.equal(JSON.stringify(seen).includes("treatment"), false);
});

test("a requested capture mode is capped at the server ceiling and the applied value is stored", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const capped = enqueueTrackedRun(queue, request(uniqueApp(), { captureMode: "full" }), deps(h, { run: async (i) => outcomeOf(i) }));
  const allowed = enqueueTrackedRun(queue, request(uniqueApp(), { captureMode: "full" }), deps(h, { run: async (i) => outcomeOf(i) }, { runConfig: { ...env, maxCapture: "full" } }));
  const unasked = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, { run: async (i) => outcomeOf(i) }));
  const off = enqueueTrackedRun(queue, request(uniqueApp(), { captureMode: "metadata" }), deps(h, { run: async (i) => outcomeOf(i) }, { runConfig: { ...env, maxCapture: "off" } }));
  await queue.drain();
  assert.equal(getStoredEffectiveConfig(capped)?.captureMode, "metadata");
  assert.equal(getStoredEffectiveConfig(allowed)?.captureMode, "full");
  assert.equal(getStoredEffectiveConfig(unasked)?.captureMode, "metadata");
  assert.equal(getStoredEffectiveConfig(off)?.captureMode, "off");
  const view = (id: string) => buildRunViewExtras(id, defaultRunViewDeps(() => true, {}))!.effectiveConfig.levers.captureMode;
  assert.deepEqual([capped, allowed, unasked, off].map(view), ["metadata", "full", "metadata", "off"]);
});

test("a run that asks for full content gets it on its trace only when the ceiling allows", async () => {
  const ceilingFull = traceHarness({ captureMode: "metadata" });
  const queue = new JobQueue();
  const content = { "gen_ai.input.messages": "hello" } as never;
  const run = (h: ReturnType<typeof traceHarness>): RunPipelinePort => ({
    run: async (i) => { h.telemetry.startSpan("qayaba.test.content", { attrs: content }).end(); return outcomeOf(i); },
  });
  enqueueTrackedRun(queue, request(uniqueApp(), { captureMode: "full" }), deps(ceilingFull, run(ceilingFull), { runConfig: { ...env, maxCapture: "full" } }));
  await queue.drain();
  assert.equal(ceilingFull.only("qayaba.test.content").attributes["gen_ai.input.messages"], "hello");

  const ceilingMeta = traceHarness({ captureMode: "metadata" });
  enqueueTrackedRun(queue, request(uniqueApp(), { captureMode: "full" }), deps(ceilingMeta, run(ceilingMeta)));
  await queue.drain();
  assert.equal(ceilingMeta.only("qayaba.test.content").attributes["gen_ai.input.messages"], undefined);
});

test("effectiveConfig records the levers, switches and grounding the run started with, in the contract's shape", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = uniqueApp();
  const id = enqueueTrackedRun(
    queue,
    request(app, { closedLoop: true, agentBrowser: false }),
    deps(h, { run: async (i) => outcomeOf(i) }, {}, cfg(app, { changeCoverage: { mode: "enforce", minRatio: 0.8 }, structuralSignals: { mode: "signal" } })),
  );
  await queue.drain();
  const detail = buildRunViewExtras(id, defaultRunViewDeps(() => true, {}))!.effectiveConfig;
  assert.deepEqual(detail, {
    levers: { closedLoop: true, agentBrowser: false, captureMode: "metadata" },
    campaignFreeze: true,
    runtime: "opencode",
    agents: {},
    prompt: { staticHash: "sha256:feed" },
    grounding: { stitcher: null, structuralSignal: "signal", curriculum: "frozen", domPack: true, dossier: true },
    coverage: { mode: "enforce", minRatio: 0.8 },
    reflector: false,
  });
  const root = h.only("qayaba.run");
  assert.equal(root.attributes["qayaba.closed_loop.enabled"], true);
  assert.equal(root.attributes["qayaba.runtime"], "opencode");
  assert.equal(root.attributes["qayaba.prompt.static_hash"], "sha256:feed");
  assert.equal(root.attributes["qayaba.coverage.policy"], "enforce");
  assert.equal(root.attributes["qayaba.campaign.freeze"], true);
  assert.equal(root.attributes["qayaba.capture_mode"], "metadata");
});

test("the roles a run invoked come from its recorded turns; a role the run never used is absent", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = uniqueApp();
  let runId = "";
  const id = enqueueTrackedRun(queue, request(app), deps(h, {
    run: async (i) => {
      runId = i.runId;
      const base = { runId, sessionId: "s", round: 0, isRepair: false, ts: "2026-10-17T10:00:00.000Z", objective: null, promptText: "p", outputText: "o", promptBytes: 1, tokensInput: 1, tokensOutput: 1, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: 0 };
      getHistory().telemetry.saveAgentTurn({ ...base, role: "qa-author", provider: "opencode-go", modelRequested: "req", modelAnswered: "glm", maxSteps: 40 });
      getHistory().telemetry.saveAgentTurn({ ...base, role: "qa-author", provider: "opencode-go", modelRequested: null, modelAnswered: "glm", maxSteps: 50, round: 1 });
      getHistory().telemetry.saveAgentTurn({ ...base, role: "qa-reviewer", provider: null, modelRequested: "mm", modelAnswered: null, maxSteps: null });
      return outcomeOf(i);
    },
  }));
  await queue.drain();
  assert.equal(runId, id);
  const { agents } = buildRunViewExtras(id, defaultRunViewDeps(() => true, {}))!.effectiveConfig;
  assert.deepEqual(agents, {
    "qa-author": { provider: "opencode-go", model: "glm", reasoningEffort: null, stepLimit: 50 },
    "qa-reviewer": { provider: null, model: "mm", reasoningEffort: null, stepLimit: null },
  });
});

test("a run that recorded no configuration answers every key as null", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, { run: async (i) => outcomeOf(i) }, { loadApp: () => { throw new Error("boom"); } }));
  await queue.drain();
  assert.equal(getRecord(id)?.verdict, "infra-error");
  const detail = buildRunViewExtras(id, defaultRunViewDeps(() => true, {}))!.effectiveConfig;
  assert.deepEqual(detail.levers, { closedLoop: null, agentBrowser: null, captureMode: "metadata" });
  assert.deepEqual([detail.campaignFreeze, detail.runtime, detail.prompt.staticHash, detail.reflector], [null, null, null, null]);
  assert.deepEqual(detail.coverage, { mode: null, minRatio: null });
});

test("a run joins a campaign only with the capture mode its siblings have, and a refused run leaves no record", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const id = `uniform-${Math.random().toString(36).slice(2, 8)}`;
  const joined = (extra: Partial<RunRequest>, e: RunConfigEnvironment = env) =>
    enqueueTrackedRun(queue, request(uniqueApp(), { campaign: { id, variant: { arm: "x" }, replicate: 1 }, ...extra }), deps(h, { run: async (i) => outcomeOf(i) }, { runConfig: e }));
  const first = joined({});
  assert.equal(getStoredEffectiveConfig(first)?.captureMode, "metadata");
  const before = listCampaignRuns(id).length;
  assert.throws(() => joined({ captureMode: "full" }, { ...env, maxCapture: "full" }), (err: unknown) => err instanceof CampaignCaptureMismatchError && err.expected === "metadata" && err.applied === "full" && /metadata/.test(err.message));
  assert.equal(listCampaignRuns(id).length, before);
  assert.doesNotThrow(() => joined({ captureMode: "metadata" }));
  /* The ceiling counts: a request for full that the ceiling caps to metadata is the same applied mode. */
  assert.doesNotThrow(() => joined({ captureMode: "full" }));
  assert.doesNotThrow(() => enqueueTrackedRun(queue, request(uniqueApp(), { campaign: { id: `${id}-other`, variant: {}, replicate: 1 }, captureMode: "off" }), deps(h, { run: async (i) => outcomeOf(i) })));
  await queue.drain();
});

test("a refused campaign run has no side effects: no login bootstrap is queued and the app is not marked as asked", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const id = `sidefx-${Math.random().toString(36).slice(2, 8)}`;
  const app = uniqueApp();
  const withLogin = (): AppConfig => ({ ...cfg(app), auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } }) as AppConfig;
  const live = (e: RunConfigEnvironment = env): RunnerDeps => deps(h, { run: async (i) => outcomeOf(i) }, { runConfig: e, suiteHoldsVerifiedLogin: () => false }, withLogin);
  /* A sibling of the campaign already runs with metadata (another app, so this app's bootstrap has not been asked). */
  enqueueTrackedRun(queue, request(uniqueApp(), { campaign: { id, variant: {}, replicate: 1 } }), deps(h, { run: async (i) => outcomeOf(i) }));
  const sizeBefore = queue.size;
  assert.throws(() => enqueueTrackedRun(queue, request(app, { campaign: { id, variant: {}, replicate: 2 }, captureMode: "full" }), live({ ...env, maxCapture: "full" })), CampaignCaptureMismatchError);
  assert.equal(queue.size, sizeBefore, "nothing was queued by the refused request");
  /* The app was not marked: an ordinary run of it still gets its bootstrap queued first. */
  enqueueTrackedRun(queue, request(app), live());
  assert.equal(queue.size, sizeBefore + 2, "the bootstrap and the run");
  await queue.drain();
});
