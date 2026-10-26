/* A checkpoint is the run's state, the digest of the specs it holds and the step it stands after: data that survives a JSON round trip, holds no secret and no handle. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { readConfinedSpecFile } from "../../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { activeRunSecretScope } from "../../../../../src/shared-kernel/run-secret-redaction.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { checkpointOf, type RunCheckpoint } from "@contexts/run-orchestration/application/run-flow/checkpoint.ts";
import { initialRunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import { EMPTY_SPEC_SET_DIGEST, specSetDigest } from "@contexts/run-orchestration/application/run-flow/spec-set-digest.ts";
import { STEP_IDS } from "@contexts/run-orchestration/application/run-flow/step-ids.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../../support/run-workspace.ts";
import { fakeWorkspace } from "./fake-workspace.ts";
import { confinedSpecFiles } from "../../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../../support/coordinator-over-author.ts";

const base = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, target: "e2e" as const, mode: "diff" as const };
const SECRET = "hunter2-hunter2-secret";

function depsFor(ws: RunWorkspace, seen: RunCheckpoint[], over: Partial<RunQaUseCaseDeps> = {}): RunQaUseCaseDeps {
  return {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    ...served(generationOnDisk({ author: async () => scriptedGeneration({ specs: ["a.spec.ts"]}) })),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => ({ verdict: "pass", cases: [], logs: `login with ${SECRET} worked` }) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async () => {} },
    setup: { setup: async () => { activeRunSecretScope()?.addAccountSecrets([SECRET]); } },
    config: { needsReview: true },
    onCheckpoint: (checkpoint) => { seen.push(checkpoint as RunCheckpoint); },
    ...over,
  };
}

/* The slice of a run's context a checkpoint reads: the run's input, its redaction and its confined reader over the working copy. */
function inWorkspace(ws: RunWorkspace, runId: string): Parameters<typeof checkpointOf>[1] {
  const root = { mirrorDir: ws.mirrorDir, specDir: ws.specDir };
  return {
    input: { ...base, runId },
    host: { redact: (text: string) => text },
    services: { specDigest: (files: readonly string[]) => specSetDigest((file) => readConfinedSpecFile(root, file), files) },
  } as unknown as Parameters<typeof checkpointOf>[1];
}

test("after a full green run the checkpoint at every step survives a JSON round trip, holds no secret and names its run and step", async () => {
  const ws = runWorkspace("qa-checkpoint-");
  const seen: RunCheckpoint[] = [];
  await new RunQaUseCase(depsFor(ws, seen)).run({ ...base, runId: "checkpoint-green" } satisfies RunQaInput);
  assert.ok(seen.length > 10, "a checkpoint per step");
  const known = new Set<string>(STEP_IDS);
  for (const checkpoint of seen) {
    assert.equal(checkpoint.version, 1);
    assert.equal(checkpoint.runId, "checkpoint-green");
    assert.ok(known.has(checkpoint.stepId), `${checkpoint.stepId} is a step of the table`);
    const text = JSON.stringify(checkpoint);
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(JSON.parse(text))), "stable under a second round trip");
    assert.equal(text.includes(SECRET), false, `no secret after ${checkpoint.stepId}`);
    assert.equal(/\[Function|\[object Map\]/.test(text), false);
    assert.deepEqual(checkpoint.loops, checkpoint.state.loops);
  }
  assert.ok(seen.some((c) => JSON.stringify(c.state).includes(REDACTED)), "the secret reached the state and the checkpoint redacted it");
});

test("the checkpoint of a run whose review is open leaves the open round's scratch out and says so in its shape", async () => {
  const ws = runWorkspace("qa-checkpoint-review-");
  const seen: RunCheckpoint[] = [];
  await new RunQaUseCase(depsFor(ws, seen)).run({ ...base, runId: "checkpoint-review" });
  const open = seen.filter((c) => c.state.review.session !== undefined);
  assert.ok(open.length > 0, "the review opened");
  for (const checkpoint of open) assert.equal(checkpoint.state.review.session?.current, undefined);
});

test("the workspace digest changes when a spec byte changes and is stable otherwise", async () => {
  const ws = runWorkspace("qa-checkpoint-digest-");
  ws.write("a.spec.ts", "// one\n");
  const state = initialRunState();
  state.generation.delivered = [{ file: "a.spec.ts" }];
  const ctx = inWorkspace(ws, "digest");
  const first = checkpointOf(state, ctx, "validate-statically").workspaceDigest;
  assert.equal(checkpointOf(state, ctx, "validate-statically").workspaceDigest, first);
  ws.write("a.spec.ts", "// two\n");
  assert.notEqual(checkpointOf(state, ctx, "validate-statically").workspaceDigest, first);
  ws.write("a.spec.ts", "// one\n");
  assert.equal(checkpointOf(state, ctx, "validate-statically").workspaceDigest, first);
});

test("a checkpoint taken before the working copy exists digests the empty set, and a spec the run cannot read digests as unreadable", () => {
  const empty = checkpointOf(initialRunState(), { input: { ...base, runId: "early" }, host: { redact: (text: string) => text } } as unknown as Parameters<typeof checkpointOf>[1], "wait-for-deploy");
  assert.equal(empty.workspaceDigest, EMPTY_SPEC_SET_DIGEST);
  const ws = runWorkspace("qa-checkpoint-missing-");
  const state = initialRunState();
  state.generation.delivered = [{ file: "gone.spec.ts" }];
  const ctx = inWorkspace(ws, "missing");
  assert.equal(checkpointOf(state, ctx, "validate-statically").workspaceDigest, "unreadable");
});
