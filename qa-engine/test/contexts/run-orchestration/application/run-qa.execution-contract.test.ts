/* The run record lists the conditions every execution of the run's suite ran under (RFC-0015), and every execution is told when the session it is given was signed in by the run. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { contractDigest, executionConditions } from "@kernel/execution-conditions.ts";
import { RunQaUseCase } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { ExecutionOpts } from "@contexts/test-execution/domain/execution.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
import { passingCases } from "../../../support/passing-cases.ts";

const INPUT = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual" as const, mode: "manual" as const, target: "e2e" as const, runId: "contract-run" };
const NONE = { coverage: false, observe: false, route: false, writeCounter: false };

function useCase(saved: RunOutcome[], asked: ExecutionOpts[], opts: { auth?: boolean; conditions?: boolean } = {}): RunQaUseCase {
  const ws = runWorkspace("qa-contract-");
  return new RunQaUseCase({
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "x", diff: "" }) },
    ...served(generationOnDisk({ author: async () => scriptedGeneration({ specs: ["a.spec.ts"] }) })),
    review: { review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: {
      execute: async (dir, given) => {
        const o = (given ?? {}) as ExecutionOpts;
        asked.push(o);
        const conditions = executionConditions({ purpose: o.purpose ?? "suite", instrumentation: NONE, processTimeoutMs: 900_000, namespace: o.namespace ?? "contract-run", startedAt: Date.now(), ...(o.session ? { session: o.session } : {}) });
        return { verdict: "pass", cases: passingCases(dir, given), logs: "", ...(opts.conditions === false ? {} : { conditions }) };
      },
    },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { verifyServed: async () => ok({ state: "undeclared" as const }), waitUntilHealthy: async () => ok(true) },
    runHistory: { save: async (outcome) => { saved.push(outcome); } },
    setup: { setup: async () => {} },
    /* A login that signs in leaves a saved session, the one thing an app's executions can lose. */
    ...(opts.auth ? { authSession: { prepare: async () => ({ unauthored: false, storageStatePath: "/auth/user.json" }) }, authContext: { baseUrl: "https://dev" } } : {}),
    config: { needsReview: false },
  } as ConstructorParameters<typeof RunQaUseCase>[0]);
}

test("the run record lists the final execution with the digest of the contract it ran under", async () => {
  const saved: RunOutcome[] = [];
  await useCase(saved, []).run(INPUT);
  const runs = saved[0]?.gateSignals.executions?.runs ?? [];
  assert.equal(runs.length, 1);
  const [final] = runs;
  assert.equal(final!.purpose, "suite");
  assert.equal(final!.kind, "judging");
  assert.equal(final!.digest, contractDigest(executionConditions({ purpose: "suite", instrumentation: NONE, processTimeoutMs: 1, namespace: "x", startedAt: 0 })));
  assert.deepEqual(final!.deviations, []);
});

test("an execution whose runner reports no conditions leaves the record without executions", async () => {
  const saved: RunOutcome[] = [];
  await useCase(saved, [], { conditions: false }).run(INPUT);
  assert.equal(saved[0]?.gateSignals.executions, undefined);
});

test("once the run signed in, each execution is told when, and the record keeps the session's age", async () => {
  const saved: RunOutcome[] = [];
  const asked: ExecutionOpts[] = [];
  const before = Date.now();
  await useCase(saved, asked, { auth: true }).run(INPUT);
  const signedInAt = asked[0]?.session?.signedInAt;
  assert.ok(signedInAt !== undefined && signedInAt >= before && signedInAt <= Date.now());
  assert.equal(typeof saved[0]?.gateSignals.executions?.runs[0]?.sessionAgeMs, "number");
});

test("a run that signs no one in tells its executions nothing about a session", async () => {
  const asked: ExecutionOpts[] = [];
  await useCase([], asked).run(INPUT);
  assert.equal(asked[0]?.session, undefined);
});
