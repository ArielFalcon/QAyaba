/* A run may grant its lead the code-graph tools: they are opened before the first generation, for the same runs the browser is, and revoked when the run ends, however it ends. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RUN_PURPOSE } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { DEFAULT_CODE_GRAPH_TOOL_LIMITS } from "@kernel/code-graph-tools.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { CodeGraphToolsHandle } from "@contexts/agent-tools/application/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";

const INPUT: RunQaInput = { app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "graph-run" };
const PASS: QaCase[] = [{ name: "a", status: "pass", file: "flows/a.spec.ts" }];

function rig(opts: { openThrows?: boolean; generateThrows?: boolean; closeThrows?: boolean } = {}) {
  const ws = runWorkspace("qa-graph-");
  const events: string[] = [];
  const handle: CodeGraphToolsHandle = {
    limits: DEFAULT_CODE_GRAPH_TOOL_LIMITS,
    signals: () => ({ calls: 3, refused: 0, failed: 1 }),
    close: () => { events.push("close"); if (opts.closeThrows) throw new Error("registry stuck"); },
  };
  const deps = (over: Partial<RunQaUseCaseDeps> = {}): RunQaUseCaseDeps => {
    const { generation: generationOver, ...rest } = over;
    return {
      changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
      generation: generationOnDisk(generationOver ?? {
        generate: async () => {
          events.push("generate");
          if (opts.generateThrows) throw new Error("agent down");
          return scriptedGeneration({ specs: ["flows/a.spec.ts"]});
        },
      }),
      review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
      validation: { validate: async () => ({ ok: true, errors: [] }) },
      execution: { execute: async () => ({ verdict: "pass", cases: PASS, logs: "" }) },
      objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: fakeWorkspace(ws),
      specFiles: confinedSpecFiles,
      suiteStore: ws.suiteStore,
      deployGate: { waitUntilServing: async () => ok(true) },
      runHistory: { save: async () => {} },
      confinement: { enforce: async () => ({ strays: 0, dangerous: 0, reverted: [] }) },
      codeGraphTools: {
        open: async (input) => {
          events.push(`open:${input.runId}`);
          if (opts.openThrows) throw new Error("graph down");
          return handle;
        },
      },
      config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false },
      ...rest,
    };
  };
  return { events, deps };
}

test("the lead's code-graph tools are granted before the first generation and revoked once when the run ends", async () => {
  const r = rig();
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.ok(r.events.indexOf("open:graph-run") < r.events.indexOf("generate"));
  assert.equal(r.events.filter((e) => e === "close").length, 1);
});

test("no code-graph tools for a code run, a context run, a regression run or a login bootstrap", async () => {
  const code = rig();
  await new RunQaUseCase(code.deps({ config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: true } })).run({ ...INPUT, target: "code" });
  assert.equal(code.events.some((e) => e.startsWith("open")), false, "code");
  const context = rig();
  await new RunQaUseCase(context.deps({ generation: { generate: async () => scriptedGeneration({ specs: [".qa/context.json"], note: "map" }) } })).run({ ...INPUT, mode: "context" });
  assert.equal(context.events.some((e) => e.startsWith("open")), false, "context");
  const regression = rig();
  await new RunQaUseCase(regression.deps({ changeAnalysis: { classify: async () => ({ action: "regression", reason: "no source change", diff: "" }) } })).run(INPUT);
  assert.equal(regression.events.some((e) => e.startsWith("open")), false, "regression");
  const bootstrap = rig();
  await new RunQaUseCase(bootstrap.deps()).run({ ...INPUT, mode: "manual", purpose: RUN_PURPOSE.LOGIN_BOOTSTRAP });
  assert.equal(bootstrap.events.some((e) => e.startsWith("open")), false, "login bootstrap");
});

test("a port that fails to open, or a revocation that throws, costs the run nothing but the tools", async () => {
  const failing = rig({ openThrows: true });
  assert.equal((await new RunQaUseCase(failing.deps()).run(INPUT)).decision.verdict, "pass");
  const stuck = rig({ closeThrows: true });
  assert.equal((await new RunQaUseCase(stuck.deps()).run(INPUT)).decision.verdict, "pass");
});

test("the tools are revoked when the run throws", async () => {
  const r = rig({ generateThrows: true });
  await assert.rejects(new RunQaUseCase(r.deps()).run(INPUT));
  assert.equal(r.events.filter((e) => e === "close").length, 1);
});
