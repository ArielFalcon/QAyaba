/*
 * A run whose app declares a location carries it as authoring context: it is opened after the login and before the first
 * generation, the generator's prompt states it, the authenticated browser resolves each session's scope through it, and it is
 * forgotten when the run ends. It decides no verdict.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RUN_PURPOSE } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { AgentBrowserOpenInput, GeolocationHandle } from "@contexts/agent-tools/application/index.ts";
import type { GenerationEnrichment } from "@contexts/generation/application/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
const INPUT: RunQaInput = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "geo-run" };
const PASS: QaCase[] = [{ name: "a", status: "pass", file: "flows/a.spec.ts" }];
const MADRID = { latitude: 40.4168, longitude: -3.7038 };
const BARCELONA = { latitude: 41.3874, longitude: 2.1686 };

function rig(opts: { openThrows?: boolean; executeThrows?: boolean; generateThrows?: boolean; moveOnGenerate?: boolean } = {}): { events: string[]; opened: { runId: string; app: string; mode: string }[]; enrichments: GenerationEnrichment[]; saved: RunOutcome[]; browserOpens: AgentBrowserOpenInput[]; executionRequests: unknown[]; ws: RunWorkspace; deps(over?: Partial<RunQaUseCaseDeps>): RunQaUseCaseDeps } {
  const ws = runWorkspace("qa-geo-");
  const events: string[] = [];
  const opened: { runId: string; app: string; mode: string }[] = [];
  const enrichments: GenerationEnrichment[] = [];
  const saved: RunOutcome[] = [];
  const browserOpens: AgentBrowserOpenInput[] = [];
  const executionRequests: unknown[] = [];
  let current = MADRID;
  const move = (location: { latitude: number; longitude: number }): void => { current = location; };
  const handle: GeolocationHandle = {
    default: MADRID,
    facts: () => ({ default: MADRID, current, places: { barcelona: BARCELONA }, scope: "run" }),
    placeNames: () => ["barcelona"],
    forSession: (sessionId) => (sessionId === "ses-lead" ? current : sessionId === "ses-flow" ? BARCELONA : undefined),
    openFlow: () => undefined,
    close: () => void events.push("geo-close"),
  };
  const deps = (over: Partial<RunQaUseCaseDeps> = {}): RunQaUseCaseDeps => {
    const { generation: generationOver, ...rest } = over;
    return {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/map.ts", diff: "" }) },
    ...served(generationOnDisk(generationOver ?? {
      author: async (_d, _s, _diff, enrichment) => {
        events.push("generate");
        enrichments.push(enrichment ?? {});
        if (opts.generateThrows) throw new Error("agent down");
        /* The agent moves the authoring location during the turn: the prompt had the default, the next execution must not see it. */
        if (opts.moveOnGenerate) move(BARCELONA);
        return scriptedGeneration({ specs: ["flows/a.spec.ts"]});
      },
    })),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async (_specDir, options) => { events.push("execute"); executionRequests.push(options ?? {}); if (opts.executeThrows) throw new Error("runner exploded"); return { verdict: "pass", cases: PASS, logs: "" }; } },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async (outcome) => void saved.push(outcome) },
    confinement: { enforce: async () => ({ strays: 0, dangerous: 0, reverted: [] }) },
    geolocation: {
      open: async (input) => {
        opened.push({ runId: input.runId, app: input.app, mode: input.mode });
        events.push("geo-open");
        if (opts.openThrows) throw new Error("registry down");
        return handle;
      },
    },
    agentBrowser: { open: async (input) => { browserOpens.push(input); return undefined; } },
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false },
    ...rest,
    };
  };
  return { events, opened, enrichments, saved, browserOpens, executionRequests, ws, deps };
}

test("without the port the run carries no authoring location and states none", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ geolocation: undefined, agentBrowser: undefined })).run(INPUT);
  assert.equal(r.enrichments[0]!.geolocation, undefined);
  assert.equal(r.opened.length, 0);
});

test("the location is opened after setup and before the first generation, and the prompt states the app's default and places", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run(INPUT);
  assert.deepEqual(r.opened, [{ runId: "geo-run", app: "demo", mode: "diff" }]);
  assert.ok(r.events.indexOf("geo-open") < r.events.indexOf("generate"));
  assert.deepEqual(r.enrichments[0]!.geolocation, { default: MADRID, current: MADRID, places: { barcelona: BARCELONA }, scope: "run" });
  assert.ok(r.events.includes("geo-close"), "the run closes it however it ends");
});

test("the authenticated browser resolves each session's scope through the run's location", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run(INPUT);
  assert.deepEqual(r.browserOpens[0]!.geolocation?.default, MADRID);
  assert.deepEqual(r.browserOpens[0]!.geolocation?.forSession("ses-lead"), MADRID);
  assert.deepEqual(r.browserOpens[0]!.geolocation?.forSession("ses-flow"), BARCELONA);
  assert.equal(r.browserOpens[0]!.geolocation?.forSession("ses-other"), undefined);
});

test("the authoring location never enters the execution request: run_spec and the suite stay on the app's default", async () => {
  const r = rig({ moveOnGenerate: true });
  await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(r.executionRequests.length, 1);
  assert.equal("geolocation" in (r.executionRequests[0] as Record<string, unknown>), false);
});

test("a port that fails to open costs the run nothing but the location", async () => {
  const r = rig({ openThrows: true });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(r.enrichments[0]!.geolocation, undefined);
});

test("no location for a code run, a context run, a regression run, a login bootstrap, or a login the generator still has to write", async () => {
  const code = rig();
  await new RunQaUseCase(code.deps({ config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: true } })).run({ ...INPUT, target: "code" });
  assert.equal(code.opened.length, 0, "code");

  const context = rig();
  await new RunQaUseCase(context.deps({ ...served({ author: async () => scriptedGeneration({ specs: [".qa/context.json"], note: "map" }) }) })).run({ ...INPUT, mode: "context" });
  assert.equal(context.opened.length, 0, "context");

  const regression = rig();
  await new RunQaUseCase(regression.deps({ changeAnalysis: { classify: async () => ({ action: "regression", reason: "no source change", diff: "" }) } })).run(INPUT);
  assert.equal(regression.opened.length, 0, "regression");

  const bootstrap = rig();
  await new RunQaUseCase(bootstrap.deps()).run({ ...INPUT, mode: "manual", purpose: RUN_PURPOSE.LOGIN_BOOTSTRAP });
  assert.equal(bootstrap.opened.length, 0, "login bootstrap");

  const unauthored = rig();
  await new RunQaUseCase(unauthored.deps({
    authSession: { prepare: async () => ({ unauthored: true }) },
    authContext: { baseUrl: "https://dev", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } },
  })).run(INPUT);
  assert.equal(unauthored.opened.length, 0, "no session yet");
});
