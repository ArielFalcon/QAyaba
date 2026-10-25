/* A run may grant its authoring agents the authenticated browser: it is opened after the login and before the first generation, the generator's prompt is told its limits, the run records how it was used, and it is closed when the run ends, however it ends. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RUN_PURPOSE } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { DEFAULT_AGENT_BROWSER_LIMITS } from "@kernel/agent-browser.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import type { AgentBrowserHandle, AgentBrowserOpenInput, GenerationEnrichment } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";
const INPUT: RunQaInput = { app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "browser-run" };
const PASS: QaCase[] = [{ name: "a", status: "pass", file: "flows/a.spec.ts" }];
const SIGNAL = { calls: 12, blocks: 3, invalidations: 1, renewals: 1 };

function rig(opts: { openThrows?: boolean; grant?: boolean; executeThrows?: boolean; generateThrows?: boolean; closeThrows?: boolean } = {}): { events: string[]; opened: AgentBrowserOpenInput[]; enrichments: GenerationEnrichment[]; saved: RunOutcome[]; ws: RunWorkspace; deps(over?: Partial<RunQaUseCaseDeps>): RunQaUseCaseDeps } {
  const ws = runWorkspace("qa-browser-");
  const events: string[] = [];
  const opened: AgentBrowserOpenInput[] = [];
  const enrichments: GenerationEnrichment[] = [];
  const saved: RunOutcome[] = [];
  const handle: AgentBrowserHandle = {
    limits: DEFAULT_AGENT_BROWSER_LIMITS,
    grantShare: () => {},
    signals: () => SIGNAL,
    close: async () => { events.push("close"); if (opts.closeThrows) throw new Error("browser stuck"); },
  };
  const deps = (over: Partial<RunQaUseCaseDeps> = {}): RunQaUseCaseDeps => {
    const { generation: generationOver, ...rest } = over;
    return {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    generation: generationOnDisk(generationOver ?? {
      generate: async (_d, _s, _diff, enrichment) => {
        events.push("generate");
        enrichments.push(enrichment ?? {});
        if (opts.generateThrows) throw new Error("agent down");
        return scriptedGeneration({ specs: ["flows/a.spec.ts"], approved: true });
      },
    }),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => { events.push("execute"); if (opts.executeThrows) throw new Error("runner exploded"); return { verdict: "pass", cases: PASS, logs: "" }; } },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: { prepare: async () => ({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }) },
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async (outcome) => void saved.push(outcome) },
    confinement: { enforce: async () => ({ strays: 0, dangerous: 0, reverted: [] }) },
    agentBrowser: {
      open: async (input) => {
        opened.push(input);
        events.push("open");
        if (opts.openThrows) throw new Error("registry down");
        return opts.grant === false ? undefined : handle;
      },
    },
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false },
    ...rest,
    };
  };
  return { events, opened, enrichments, saved, ws, deps };
}

test("without the port, or when it grants nothing, the run is what it always was", async () => {
  const none = rig();
  await new RunQaUseCase(none.deps({ agentBrowser: undefined })).run(INPUT);
  assert.equal(none.enrichments[0]!.agentBrowser, undefined);

  const refused = rig({ grant: false });
  const out = await new RunQaUseCase(refused.deps()).run(INPUT);
  assert.equal(refused.enrichments[0]!.agentBrowser, undefined);
  assert.equal(out.gateSignals.agentBrowser, undefined);
  assert.equal(refused.events.includes("close"), false);
});

test("the browser is opened for the run after its setup and before the first generation, and the generator is told its limits", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run(INPUT);
  assert.deepEqual(r.opened, [{ runId: "browser-run", app: "demo", mode: "diff", specDir: r.ws.specDir }]);
  assert.ok(r.events.indexOf("open") < r.events.indexOf("generate"));
  assert.deepEqual(r.enrichments[0]!.agentBrowser, DEFAULT_AGENT_BROWSER_LIMITS);
});

test("a per-run choice reaches the port", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run({ ...INPUT, agentBrowser: false });
  assert.equal(r.opened[0]!.enabled, false);
});

test("no browser for a code run, a context run, a regression run, a login bootstrap, or a login the generator still has to write", async () => {
  const code = rig();
  await new RunQaUseCase(code.deps({ config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: true } })).run({ ...INPUT, target: "code" });
  assert.equal(code.opened.length, 0, "code");

  const context = rig();
  await new RunQaUseCase(context.deps({ generation: { generate: async () => scriptedGeneration({ specs: [".qa/context.json"], approved: true, note: "map" }) } })).run({ ...INPUT, mode: "context" });
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

test("a port that fails to open costs the run nothing but the browser", async () => {
  const r = rig({ openThrows: true });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(r.enrichments[0]!.agentBrowser, undefined);
});

test("the run records how the browser was used, on the outcome it saves and on the result it returns", async () => {
  const r = rig();
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.deepEqual(out.gateSignals.agentBrowser, SIGNAL);
  assert.deepEqual(r.saved.at(-1)?.gateSignals.agentBrowser, SIGNAL);
});

test("the browser is closed once when the run ends, and a close that throws does not change the result", async () => {
  const r = rig({ closeThrows: true });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(r.events.filter((e) => e === "close").length, 1);
});

test("the browser is closed when the run throws, whichever phase it was in", async () => {
  const generating = rig({ generateThrows: true });
  await assert.rejects(new RunQaUseCase(generating.deps()).run(INPUT));
  assert.equal(generating.events.filter((e) => e === "close").length, 1);

  const executing = rig({ executeThrows: true });
  await assert.rejects(new RunQaUseCase(executing.deps()).run(INPUT));
  assert.equal(executing.events.filter((e) => e === "close").length, 1);
});

test("a run cancelled before it generates still closes the browser it opened", async () => {
  const r = rig();
  const controller = new AbortController();
  await new RunQaUseCase(r.deps({
    generation: { generate: async () => { controller.abort(); throw new Error("aborted"); } },
  })).run(INPUT, controller.signal).catch(() => undefined);
  assert.equal(r.events.filter((e) => e === "close").length, 1);
});
