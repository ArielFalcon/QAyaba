/*
 * ADR-0005 under the execution contract (RFC-0015): a coverage the run could not measure is unknown, and unknown never blocks, under
 * enforce too; the objective signal's `blocks` is the one place that says what blocks. A change with no changed code line runs no
 * measurement execution and records no change-coverage. Each run goes through RunQaUseCase with fakes that answer by what they are
 * asked (the execution's purpose), never by call order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunQaUseCase } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { ok } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { reassignableGeneration, runWorkspace } from "../../../support/run-workspace.ts";
import { coordinatorOver } from "../../../support/coordinator-over-author.ts";
import { citingRejections } from "../../../support/cited-rejection.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
import { fakeHandle, rootsOf } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";

type AnyObj = Record<string, any>;

const CODE_DIFF = "diff --git a/src/a.ts b/src/a.ts\n+changed\n";
const CODELESS_DIFF = "diff --git a/src/types.ts b/src/types.ts\n+export type Id = string;\n";
const PASS_SIGNAL = { status: "pass", ratio: 0.9, uncovered: [], untakenArms: [], measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1 } };
const NO_CHANGED_LINES = { status: "unknown", ratio: null, measurement: { changedLines: 0, coveredChanged: 0, changedFiles: 0, mappedFiles: 0, unmeasured: "no-changed-lines" } };

interface Scenario {
  diff: string;
  mode: "signal" | "enforce";
  signal: AnyObj;
  /* The measurement execution's runner crashes (an infra-error). */
  measurementCrashes?: boolean;
  /* What the objective signal says of the change before anything runs; absent, the port cannot tell. */
  holdsChangedCode?: boolean;
}

async function run(id: string, scn: Scenario) {
  const ws = runWorkspace("qa-coverage-unknown-");
  const purposes: string[] = [];
  const publications: AnyObj[] = [];
  const saved: AnyObj[] = [];
  const generation = reassignableGeneration((async (specDir: string) => {
    writeFileSync(join(specDir, "a.spec.ts"), "// generation 1\n");
    return scriptedGeneration({ specs: ["a.spec.ts"] });
  }) as any);
  const caseOf = (status: string): AnyObj => ({ name: "a.spec.ts › runs", status, expectedStatus: "passed", file: "a.spec.ts" });
  const deps: AnyObj = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches the change", diff: scn.diff }) },
    generation,
    leadSidekicks: coordinatorOver(generation),
    review: { review: citingRejections(async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true })) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: {
      execute: async (_dir: string, given?: unknown) => {
        const o: AnyObj = given === undefined || given instanceof AbortSignal ? {} : (given as AnyObj);
        purposes.push(o.purpose ?? "verdict");
        if (o.purpose === "measurement" && scn.measurementCrashes) return { verdict: "infra-error", cases: [], logs: "playwright runner crashed" };
        return { verdict: "pass", cases: [caseOf("pass")], logs: "", ...(o.purpose === "measurement" ? { observations: [] } : {}) };
      },
    },
    objectiveSignal: {
      measure: async () => scn.signal,
      blocks: (status: string) => scn.mode === "enforce" && status === "fail",
      ...(scn.holdsChangedCode !== undefined ? { holdsChangedCode: () => scn.holdsChangedCode } : {}),
    },
    publication: {
      publish: async (d: AnyObj) => {
        publications.push({ verdict: d.verdict, coverageBlocks: d.coverageBlocks ?? null });
        return { outcome: d.verdict === "pass" ? "pr" : "issue" };
      },
    },
    workspace: { readRoots: rootsOf, prepare: async () => fakeHandle({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }) },
    specFiles: confinedSpecFiles,
    deployGate: { verifyServed: async () => ok({ state: "undeclared" as const }), waitUntilHealthy: async () => ok(true) },
    runHistory: { save: async (outcome: AnyObj) => { saved.push(outcome); } },
    setup: { setup: async () => {} },
    cleanup: { cleanup: async () => {} },
    suiteStore: ws.suiteStore,
    config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, coveragePolicyMode: scn.mode },
  };
  try {
    const out = await new RunQaUseCase(deps as any).run({ app: "demo", sha: Sha.of("abc1234"), changeSet: primaryChangeSet("demo", Sha.of("abc1234")), source: "manual", mode: "diff", target: "e2e", runId: `coverage-unknown-${id}` } as any);
    return { out: out as AnyObj, purposes, publications, persisted: saved.at(-1) as AnyObj };
  } finally {
    ws.cleanup?.();
  }
}

test("under enforce a measurement execution that crashed leaves the coverage unknown, and the green run is published", async () => {
  const { out, publications, persisted } = await run("enforce-measurement-crashes", { diff: CODE_DIFF, mode: "enforce", signal: PASS_SIGNAL, measurementCrashes: true });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
  assert.equal(out.errorClass ?? null, null);
  assert.deepEqual(publications, [{ verdict: "pass", coverageBlocks: false }]);
  assert.equal(persisted.gateSignals.coverageStatus ?? persisted.gateSignals.coverage?.status ?? "unknown", "unknown");
  assert.deepEqual(persisted.gateSignals.changeCoverage, { executableLines: 0, unmeasured: "measurement-not-run" }, "why nothing was measured is recorded");
});

for (const mode of ["signal", "enforce"] as const) {
  test(`a change whose measurement counted no changed code line records no change-coverage (${mode})`, async () => {
    const { out, persisted } = await run(`codeless-measured-${mode}`, { diff: CODELESS_DIFF, mode, signal: NO_CHANGED_LINES });

    assert.equal(out.decision.sideEffect, "pr");
    assert.equal(persisted.gateSignals.changeCoverage, undefined);
  });
}

test("a change with no changed code line runs no measurement execution, so one that would crash cannot hold the run, and records no change-coverage", async () => {
  const { out, purposes, publications, persisted } = await run("codeless-enforce-crashes", { diff: CODELESS_DIFF, mode: "enforce", signal: NO_CHANGED_LINES, measurementCrashes: true, holdsChangedCode: false });

  assert.equal(purposes.includes("measurement"), false, "no measurement execution ran");
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
  assert.deepEqual(publications, [{ verdict: "pass", coverageBlocks: false }]);
  assert.equal(persisted.gateSignals.changeCoverage, undefined);
});

test("a change that holds code runs its measurement execution", async () => {
  const { purposes } = await run("code-measured", { diff: CODE_DIFF, mode: "signal", signal: PASS_SIGNAL, holdsChangedCode: true });

  assert.equal(purposes.filter((p) => p === "measurement").length, 1);
});
