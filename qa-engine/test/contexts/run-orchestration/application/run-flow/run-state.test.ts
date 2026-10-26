/* The state a run carries is data: at every step it holds no function, no live object and nothing a JSON round trip would change. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import { initialRunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../../support/run-workspace.ts";
import { fakeWorkspace } from "./fake-workspace.ts";
import { confinedSpecFiles } from "../../../../../src/shared-infrastructure/spec-files.adapter.ts";

/* What a JSON round trip keeps: the walk throws at the first value it would change or lose, and otherwise returns the value without its undefined fields. */
function plainData(value: unknown, path: string): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} is not a finite number`);
    return value;
  }
  assert.notEqual(typeof value, "function", `${path} is a function`);
  assert.equal(typeof value === "object", true, `${path} is a ${typeof value}`);
  if (Array.isArray(value)) return value.map((item, index) => plainData(item, `${path}[${index}]`));
  /* A value object (a class with fields and no behavior, like a decision) is data; a collection, a typed array or anything with methods holds more than a JSON round trip keeps. */
  const proto = Object.getPrototypeOf(value) as object | null;
  const isValueObject = proto === null || proto === Object.prototype || Object.getOwnPropertyNames(proto).every((name) => name === "constructor");
  assert.ok(isValueObject && !(value instanceof Map) && !(value instanceof Set) && !ArrayBuffer.isView(value), `${path} is a ${proto?.constructor?.name ?? "foreign object"}, not plain data`);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const plain = plainData(item, `${path}.${key}`);
      return plain === undefined ? [] : [[key, plain]];
    }),
  );
}

const assertRoundTrips = (state: Readonly<RunState>, where: string): void => {
  const plain = plainData(state, "state");
  assert.deepEqual(JSON.parse(JSON.stringify(state)), plain, `the state does not survive a JSON round trip ${where}`);
};

test("a run's initial state is plain data", () => {
  assertRoundTrips(initialRunState(), "at the start");
});

const base = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, target: "e2e" as const, mode: "diff" as const };

/* Runs the pipeline and checks the state after every step, except while a review round holds its snapshot of the suite. */
async function runChecked(input: RunQaInput, execute: RunQaUseCaseDeps["execution"]["execute"]): Promise<{ checked: number; loopSteps: number }> {
  const ws = runWorkspace("qa-run-state-");
  let checked = 0;
  let loopSteps = 0;
  const deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    generation: generationOnDisk({ generate: async () => scriptedGeneration({ specs: ["a.spec.ts"], approved: true }) }),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async () => {} },
    setup: { setup: async () => {} },
    config: { needsReview: true },
    stateObserver: (observed, event) => {
      const state = observed as RunState;
      if (state.review.session !== undefined) return;
      assertRoundTrips(state, `after the step "${event.id}"`);
      checked++;
      if (state.fixLoop.session !== undefined) loopSteps++;
    },
  };
  await new RunQaUseCase(deps).run(input);
  return { checked, loopSteps };
}

test("the state of a green run is plain data after every step", async () => {
  const { checked } = await runChecked({ ...base, runId: "state-green" }, async () => ({ verdict: "pass", cases: [], logs: "" }));
  assert.ok(checked > 10, "the observer saw the run's steps");
});

test("the state of a run whose fix loop engages is plain data after every step of the loop", async () => {
  let calls = 0;
  const { checked, loopSteps } = await runChecked({ ...base, runId: "state-fix-loop" }, async () => {
    calls++;
    return calls === 1 ? { verdict: "fail", cases: [{ name: "case", status: "fail", file: "a.spec.ts", detail: "expected 1 to equal 2" }], logs: "" } : { verdict: "pass", cases: [], logs: "" };
  });
  assert.ok(calls >= 2, "the loop re-executed");
  assert.ok(loopSteps > 0, "the observer saw the loop in progress");
  assert.ok(checked > 10);
});
