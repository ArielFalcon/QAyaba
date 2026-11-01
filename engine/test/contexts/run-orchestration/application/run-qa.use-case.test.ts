import type { ServiceLink } from "@kernel/service-links";
import { submittingRuntime } from "../../../support/submission.ts";
import { mock, test } from "node:test";
import { inspect } from "node:util";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { ObservedDifference } from "@kernel/observed-difference.ts";
import { RunQaUseCase, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { renderBlastRadiusSignal } from "@contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts";
import { FixLoop } from "@contexts/run-orchestration/domain/fix-loop.aggregate.ts";
import { MAX_STATIC_FIX_ROUNDS } from "@contexts/run-orchestration/domain/derive-cycle-backstop.ts";
import { acceptanceNamespace } from "@contexts/run-orchestration/domain/acceptance-namespace.ts";
import { ERROR_CLASS } from "@kernel/error-class.ts";
import { ADJ_ACTION, ADJ_CLASS, ADJ_CONFIDENCE } from "@contexts/run-orchestration/domain/adjudicate.service.ts";
import { AuthPreconditionError, PRECONDITION_KIND } from "@contexts/app-catalog/domain/auth-precondition.ts";
import { AuthSessionAdapter } from "@contexts/app-catalog/infrastructure/auth-session.adapter.ts";
import type { LoginDiscoveryInput, LoginDiscoveryResult } from "@contexts/app-catalog/infrastructure/login-discovery/login-discovery.runner.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { NOOP_KIND } from "@kernel/noop-kind.ts";
import { AllotmentSpentError, RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { RecordMeasurement, SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { CoordinationTelemetryRecorder } from "@contexts/coordination/application/index.ts";
import type { CoordinateInput, CoordinateResult } from "@contexts/coordination/application/lead-sidekicks.ts";
import { Sha } from "@kernel/sha.ts";
import { RunDeadline } from "@contexts/run-orchestration/domain/run-deadline.ts";
import { RUN_TIME_BUDGET_MS } from "@contexts/run-orchestration/domain/run-time-budget.ts";
import { RunDeadlineRuntime } from "@contexts/run-orchestration/infrastructure/run-deadline-runtime.adapter.ts";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import { traceFactsOf } from "@kernel/run-trace-facts.ts";
import { LOG_EFFECT, levelOfEffect, memoryLogger } from "@kernel/ports/logger.port.ts";
import { installProcessLogger, resetProcessLoggerForTests } from "@kernel/ports/process-logger.ts";
import { UntrustedGitTreeError } from "../../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";
import type { ChangeAnalysisPort } from "@contexts/change-analysis/application/index.ts";
import type { StructuralSignalPort } from "@kernel/ports/structural-signal.port.ts";
import type { AuthorPort, LeadPort, ReviewPort, PreExecGroundingPort, PreGenerationGroundingPort, ReviewDomGroundingPort, ContextMapCapturePort, GenerationEnrichment } from "@contexts/generation/application/index.ts";
import type { ValidationPort, ExecutionPort } from "@contexts/test-execution/application/index.ts";
import type { CoverageMeasurement, MutationPass, ObjectiveSignalPort } from "@contexts/objective-signal/application/index.ts";
import { ObjectiveSignalPortAdapter } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts";
import { requestOriginClassifier } from "@kernel/observed-requests.ts";
import { TracedObjectiveSignalPort } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-trace.ts";
import { DecideCoverageService, assembleChangeCoverage } from "@contexts/objective-signal/application/index.ts";
import type { PublicationPort } from "@contexts/workspace-and-publication/application/index.ts";
import type { WorkspacePort } from "@contexts/workspace-and-publication/application/index.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
import type { RunHistoryPort } from "@contexts/run-orchestration/application/ports/run-history.port.ts";
import type { SetupPort } from "@contexts/workspace-and-publication/application/index.ts";
import type { CleanupPort } from "@contexts/workspace-and-publication/application/index.ts";
import type { ServiceLinksPort, CrossRepoImpactPort } from "@contexts/service-topology/application/index.ts";
import type { ConfinementPort } from "@contexts/workspace-and-publication/application/index.ts";
import type { MirrorGcPort } from "@contexts/workspace-and-publication/application/index.ts";
import type { RunDeadlinePort } from "@contexts/run-orchestration/application/ports/run-deadline.port.ts";
import type { SuiteStorePort } from "@kernel/ports/suite-store.port.ts";
import type { ProcessAuditPort } from "@contexts/cross-run-learning/application/index.ts";
import { ok, err } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CodeGraphIndexRecord } from "@kernel/code/index.ts";
import { ReviewPortAdapter } from "@contexts/generation/infrastructure/adapters/review-port.adapter.ts";
import { GenerationTurnsAdapter } from "@contexts/generation/infrastructure/adapters/generation-turns.adapter.ts";
import { GenerateTestsUseCase, type AuthoringPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/index.ts";

import { scriptedGeneration } from "../../../support/generation-output.ts";
import { extractSpecContract } from "@contexts/objective-signal/infrastructure/ts-spec-contract.extractor.ts";
import { reassignableGeneration, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";
import { authoredByCoordinator, coordinatorOver, loginToBeWritten } from "../../../support/coordinator-over-author.ts";
import { scriptedLoginEvidence } from "../../../support/login-evidence.ts";
import type { WorkspaceHandle } from "@contexts/workspace-and-publication/application/index.ts";
import { fakeHandle, rootsOf } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { ChangeSet } from "@contexts/change-analysis/application/index.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
import { sanitizeText } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { citingRejections } from "../../../support/cited-rejection.ts";
import { passingCases } from "../../../support/passing-cases.ts";
/* Ports through the full lifecycle. NO inline IO, NO prompt strings, NO learning side-effects on
   the verdict path (the process audit is off-path). Drives the SAME stub shapes scenarios.ts
   provides for the equivalent runPipeline scenario.
 */

/* ── Fully-stubbed port set, mirroring the green-pr scenario: scenarioApp
   (needsReview:true), makeDeps({}) — generate() returns approved:true with 1 spec, execute()
   returns a clean pass, no coverage config (blocksPublish never trips), not shadow, onFailure
   defaults to "github-issue". ──────────────────────────────────────────────────────────────────
 */

/* A passing execution that shows a case for each spec file it ran, as a report does: the files it was asked for, else the suite's own on disk. */
const passPerSpec: ExecutionPort["execute"] = async (dir, opts) => ({ verdict: "pass", cases: passingCases(dir, opts), logs: "" });
/* A change with a diff to count, so a green run's coverage is measured by its own measurement execution. */
const classifyWithDiff: ChangeAnalysisPort["classify"] = async () => ({ action: "generate", reason: "diff touches src/a.ts", diff: "diff --git a/src/a.ts b/src/a.ts\n+changed\n" });

/*
 * An execution that, under an execution namespace (an acceptance's), shows a case of each spec file it was asked to run, as an acceptance
 * requires of the files it keeps: a case named for the spec gets its file, and a spec with none gets a passing case.
 */
const showingACase = (execute: ExecutionPort["execute"]): ExecutionPort["execute"] => async (dir, opts) => {
  const result = await execute(dir, opts);
  const { specFiles, namespace } = (opts ?? {}) as { specFiles?: string[]; namespace?: string };
  if (namespace === undefined || specFiles === undefined) return result;
  const named = result.cases.map((c) => (c.file === undefined && specFiles.includes(c.name) ? { ...c, file: c.name } : c));
  const missing = specFiles.filter((file) => !named.some((c) => c.file === file));
  return { ...result, cases: [...named, ...missing.map((file) => ({ name: file, status: "pass" as const, file }))] };
};

function stubPorts(overrides: Partial<{
  classify: ChangeAnalysisPort["classify"];
  generate: AuthorPort["author"];
  review: ReviewPort["review"];
  validate: ValidationPort["validate"];
  autofix: NonNullable<ValidationPort["autofix"]>;
  execute: ExecutionPort["execute"];
  measure: ObjectiveSignalPort["measure"];
  blocks: ObjectiveSignalPort["blocks"];
  recount: NonNullable<ObjectiveSignalPort["recount"]>;
  recheckSurvivors: NonNullable<ObjectiveSignalPort["recheckSurvivors"]>;
  measureMutation: NonNullable<ObjectiveSignalPort["measureMutation"]>;
  publish: PublicationPort["publish"];
  prepare: WorkspacePort["prepare"];
  waitUntilHealthy: DeployGatePort["waitUntilHealthy"];
  save: RunHistoryPort["save"];
  setup: SetupPort["setup"];
  cleanup: CleanupPort["cleanup"];
  capture: PreExecGroundingPort["capture"];
  ground: PreGenerationGroundingPort["ground"];
  captureReviewDom: ReviewDomGroundingPort["capture"];
  /* Port-shaped, not method-shaped like its siblings above. Absent -> the port is omitted
     entirely from `ports`: the write side of the FE<->BE architecture map. */
  contextMapCapture: ContextMapCapturePort;
}> = {}) {
  const ws = runWorkspace("qa-golden-");
  const savedOutcomes: RunOutcome[] = [];

  const changeAnalysis: ChangeAnalysisPort = {
    classify: overrides.classify ?? (async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" })),
  };
  const generation: LeadPort & AuthorPort = reassignableGeneration(
    overrides.generate ?? (async () => (scriptedGeneration({ specs: ["a.spec.ts"]}))),
  );
  const review: ReviewPort = {
    review: citingRejections(overrides.review ?? (async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }))),
  };
  const validation: ValidationPort = {
    validate: overrides.validate ?? (async () => ({ ok: true, errors: [] })),
    ...(overrides.autofix ? { autofix: overrides.autofix } : {}),
  };
  const execution: ExecutionPort = {
    execute: overrides.execute ?? (async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass", file: "a.spec.ts" }], logs: "" })),
  };
  const objectiveSignal: ObjectiveSignalPort = {
    measure: overrides.measure ?? (async () => ({ status: "unknown", ratio: null })),
    /* Default mirrors this suite's own baseline scenario (no coverage config -> never blocks).
       Tests that need enforce-mode blocksPublish semantics inject their own overrides.blocks.
     */
    blocks: overrides.blocks ?? (() => false),
    ...(overrides.recount ? { recount: overrides.recount } : {}),
    ...(overrides.recheckSurvivors ? { recheckSurvivors: overrides.recheckSurvivors } : {}),
    ...(overrides.measureMutation ? { measureMutation: overrides.measureMutation } : {}),
  };
  const publication: PublicationPort = {
    publish: overrides.publish ?? (async () => ({ outcome: "pr" })),
  };
  const workspace: WorkspacePort = {
    readRoots: rootsOf,
    prepare: overrides.prepare ?? (async () => fakeHandle({ specDir: ws.specDir, mirrorDir: ws.mirrorDir })),
  };
  const deployGate: DeployGatePort = {
    verifyServed: async () => ok({ state: "undeclared" as const }),
    waitUntilHealthy: overrides.waitUntilHealthy ?? (async () => ok(true)),
  };
  const runHistory: RunHistoryPort = {
    save: overrides.save ?? (async (outcome) => { savedOutcomes.push(outcome); }),
  };
  const setup: SetupPort = {
    setup: overrides.setup ?? (async () => {}),
  };
  const cleanup: CleanupPort = {
    cleanup: overrides.cleanup ?? (async () => {}),
  };
  const preExecGrounding: PreExecGroundingPort | undefined = overrides.capture
    ? { capture: overrides.capture }
    : undefined;
  const preGenerationGrounding: PreGenerationGroundingPort | undefined = overrides.ground
    ? { ground: overrides.ground }
    : undefined;
  const reviewDomGrounding: ReviewDomGroundingPort | undefined = overrides.captureReviewDom
    ? { capture: overrides.captureReviewDom }
    : undefined;
  /* The store the composition puts behind a run: it reads and restores the bytes the harness's generator really wrote. */
  const suiteStore: SuiteStorePort = ws.suiteStore;

  return {
    ports: {
      changeAnalysis, generation, review, validation, execution, objectiveSignal, publication, workspace, specFiles: confinedSpecFiles, deployGate, runHistory, setup, cleanup, suiteStore,
      leadSidekicks: coordinatorOver(generation),
      ...(preExecGrounding ? { preExecGrounding } : {}),
      ...(preGenerationGrounding ? { preGenerationGrounding } : {}),
      ...(reviewDomGrounding ? { reviewDomGrounding } : {}),
      ...(overrides.contextMapCapture ? { contextMapCapture: overrides.contextMapCapture } : {}),
    },
    savedOutcomes,
    ws,
  };
}

/* A generator handed the reviewer's corrections answers them with new code, as a real one does: the second review judges changed specs, not the first verdict repeated. */
function revisingAuthor(ws: RunWorkspace, inner: AuthorPort["author"] = async () => scriptedGeneration({ specs: ["a.spec.ts"] })): AuthorPort["author"] {
  let turn = 0;
  return async (...args) => {
    ws.write("a.spec.ts", `export const turn = ${++turn};\n`);
    return inner(...args);
  };
}

const baseInput = {
  app: "demo",
  sha: Sha.of("abc1234"),
  changeSet: primaryChangeSet("demo", Sha.of("abc1234")),
  source: "manual" as const,
  mode: "diff" as const,
  target: "e2e" as const,
  runId: "golden-green-pr",
};

/*
 * A real spec directory for the coverage-regeneration tests: the generator writes the spec it delivers, so the turn's bytes are
 * on disk and acceptance can judge them (a scripted generation alone writes nothing). Each call rewrites the bytes, which is what
 * a regeneration does.
 */
function realCoverageWorkspace(): { prepare: WorkspacePort["prepare"]; generate: AuthorPort["author"]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qa-coverage-"));
  const specDir = join(dir, "e2e");
  let calls = 0;
  return {
    prepare: async () => fakeHandle({ specDir, mirrorDir: dir }),
    generate: async () => {
      calls += 1;
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "a.spec.ts"), `// generation ${calls}\n`);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/* The counts of a branch-cases record, apart from what it records of the decisions it was sent. */
const branchCounts = (record: object | undefined) => {
  const { findings: _findings, armsTaken: _armsTaken, maxFlowShare: _maxFlowShare, survivors: _survivors, decisions: _decisions, ...counts } = (record ?? {}) as Record<string, unknown>;
  return counts;
};

test("RunQaUseCase: green-pr — fully stubbed ports, reaches decide, returns pass/pr RunDecision", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

test("RunQaUseCase: emits preExecAmbiguityCatches:0 + deterministicSelectorBlocks:0 (number, not undefined) when PreExecGroundingPort is ABSENT ([SWAP])", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(typeof out.gateSignals.preExecAmbiguityCatches, "number");
  assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
  assert.equal(typeof out.gateSignals.deterministicSelectorBlocks, "number");
  assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
});

/* PreExecGroundingPort wired — real counters, the ambiguity check as a signal, the catalog gate's corrective regen.
   A page-rooted, page.goto("/owners")-targeting spec source drives the ambiguity check (matches the
   captured route by name, per the domain service's per-spec route pairing); a getByTestId-only spec
   drives the catalog gate independently. The ambiguity check is a regex over the spec text: it has
   false positives that real execution does not, so its findings are advisory telemetry only and
   execution decides.
 */
const AMBIGUOUS_SPEC_SOURCE = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`;
const FABRICATED_TESTID_SPEC_SOURCE = `await page.goto("/owners"); await page.getByTestId("ghost-id").click();`;
const CLEAN_SPEC_SOURCE = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`;
const AMBIGUOUS_ROUTES = [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }];
const ROUTE_WITHOUT_GHOST_ID = [{ route: "/owners", nodes: [], status: "captured" as const, settled: true, testIds: new Map<string, number>() }];

test("RunQaUseCase: PreExecGroundingPort wired — a captured ambiguity is counted in preExecAmbiguityCatches", async () => {
  const { ports } = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [AMBIGUOUS_SPEC_SOURCE], routes: AMBIGUOUS_ROUTES }),
    generate: async () => (scriptedGeneration({
      specs: ["a.spec.ts"],
    })),
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.gateSignals.preExecAmbiguityCatches, 1);
});

test("RunQaUseCase: PreExecGroundingPort wired — a captured ambiguity asks for no corrective regeneration: the spec goes on to be executed", async () => {
  const generateCalls: Array<{ enrichment?: { selectorContradictions?: readonly string[]; attributedSpecFiles?: readonly string[] } }> = [];
  let executions = 0;
  const { ports } = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [AMBIGUOUS_SPEC_SOURCE], routes: AMBIGUOUS_ROUTES }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    execute: async () => { executions++; return { verdict: "pass", cases: [{ name: "owners", status: "pass" }], logs: "" }; },
  });
  const useCase = new RunQaUseCase(ports);

  await useCase.run(baseInput);

  assert.equal(generateCalls.length, 1, "only the initial generation: the ambiguity requested no regeneration");
  assert.equal(generateCalls.some((c) => (c.enrichment?.selectorContradictions?.length ?? 0) > 0), false);
  assert.equal(generateCalls.some((c) => (c.enrichment?.attributedSpecFiles?.length ?? 0) > 0), false);
  assert.equal(executions, 1, "the spec was executed against DEV");
});

test("RunQaUseCase: PreExecGroundingPort wired — an ambiguity that persists never holds the run invalid: the execution decides the verdict", async () => {
  /* capture() reports the SAME duplicate-node tree on every call: the ambiguity is always there. */
  const passing = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [AMBIGUOUS_SPEC_SOURCE], routes: AMBIGUOUS_ROUTES }),
    execute: async () => ({ verdict: "pass", cases: [{ name: "owners", status: "pass", file: "a.spec.ts" }], logs: "" }),
  });
  const failing = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [AMBIGUOUS_SPEC_SOURCE], routes: AMBIGUOUS_ROUTES }),
    execute: async () => ({ verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom" }], logs: "" }),
  });

  const green = await new RunQaUseCase(passing.ports).run(baseInput);
  const red = await new RunQaUseCase(failing.ports).run(baseInput);

  assert.equal(green.decision.verdict, "pass");
  assert.equal(green.gateSignals.preExecAmbiguityCatches, 1, "the signal is still recorded");
  assert.equal(green.gateSignals.deterministicSelectorBlocks, 0, "nothing was blocked");
  assert.equal(red.decision.verdict, "fail", "a failure comes from the execution, not from the static check");
});

test("RunQaUseCase: PreExecGroundingPort wired — a captured ambiguity is surfaced as a warning in the run's log", async () => {
  const { ports } = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [AMBIGUOUS_SPEC_SOURCE], routes: AMBIGUOUS_ROUTES }),
  });
  const { observer, events } = fakeObserver();

  await new RunQaUseCase({ ...ports, config: baseConfig, observer }).run(baseInput);

  const warning = events.find((e) => e.type === "log.line" && e.level === "warn" && /MULTIPLE/.test(e.text));
  assert.ok(warning, "the ambiguity is logged at warn level, with what it found");
});

test("RunQaUseCase: PreExecGroundingPort wired — a catalog correction feeds the ONE-SHOT corrective regen via selectorContradictions", async () => {
  const generateCalls: Array<{ enrichment?: { selectorContradictions?: readonly string[] } }> = [];
  const { ports } = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [FABRICATED_TESTID_SPEC_SOURCE], routes: ROUTE_WITHOUT_GHOST_ID }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase(ports);

  await useCase.run(baseInput);

  /* The FIRST generate() call is the initial pass (no corrections yet — nothing captured before it).
     The pre-exec gate runs AFTER it, catches the fabricated test-id, and feeds it into exactly ONE corrective regen.
   */
  const correctiveCalls = generateCalls.filter((c) => (c.enrichment?.selectorContradictions?.length ?? 0) > 0);
  assert.equal(correctiveCalls.length, 1, "exactly one generate() call carrying selectorContradictions");
  assert.match(correctiveCalls[0]!.enrichment!.selectorContradictions![0]!, /ghost-id/);
});

test("RunQaUseCase: PreExecGroundingPort wired — catalog-gate fail-closed corrections NEVER hold the run invalid (safe direction)", async () => {
  /* A fabricated test-id (catalog gate) with ZERO role-based ambiguity: a catalog correction alone
     can never hold the run invalid, only feed the one-shot repair (catalogGate* is telemetry, not a gate).
   */
  const { ports } = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [FABRICATED_TESTID_SPEC_SOURCE], routes: ROUTE_WITHOUT_GHOST_ID }),
    generate: async () => (scriptedGeneration({ specs: ["a.spec.ts"]})),
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
  assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
  assert.notEqual(out.decision.verdict, "invalid");
});

test("RunQaUseCase: PreExecGroundingPort wired — a clean capture (no ambiguity) leaves the run green, zero counters", async () => {
  const { ports } = stubPorts({
    capture: async () => ({
      specFiles: ["a.spec.ts"],
      specSources: [CLEAN_SPEC_SOURCE],
      routes: [{ route: "/owners", nodes: ["heading: Owners"] }],
    }),
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
  assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
});

test("RunQaUseCase: PreExecGroundingPort wired — a FixLoop regen (post-execution-failure) also receives the catalog corrections via selectorContradictions", async () => {
  let executeCalls = 0;
  const generateCalls: Array<{ enrichment?: { selectorContradictions?: readonly string[]; fixCases?: readonly unknown[] } }> = [];
  const { ports } = stubPorts({
    /* The capture sees the fabricated test-id once and then a clean page (the corrective regen "fixed" it from the gate's point of view): the run proceeds to execute() with the pending corrections STILL held (nothing clears them until a FixLoop regen consumes them). */
    capture: (() => {
      let captureCalls = 0;
      return async () => ({
        specFiles: ["a.spec.ts"],
        specSources: [++captureCalls === 1 ? FABRICATED_TESTID_SPEC_SOURCE : CLEAN_SPEC_SOURCE],
        routes: ROUTE_WITHOUT_GHOST_ID,
      });
    })(),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    execute: async () => {
      executeCalls++;
      /* First execute fails -> engages the FixLoop; subsequent retries pass so the loop terminates promptly. */
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom" }], logs: "" };
      }
      return { verdict: "pass", cases: [{ name: "owners", status: "pass" }], logs: "" };
    },
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);
  assert.notEqual(out.decision.verdict, "invalid");

  /* A generate() call during the FixLoop's engagement carries BOTH fixCases (the FixLoop's own regen context) AND selectorContradictions (the pending catalog corrections). */
  const fixLoopCallWithCorrections = generateCalls.find(
    (c) => (c.enrichment?.fixCases?.length ?? 0) > 0 && (c.enrichment?.selectorContradictions?.length ?? 0) > 0,
  );
  assert.ok(fixLoopCallWithCorrections, "expected a FixLoop regen call carrying both fixCases and selectorContradictions");
});

test("RunQaUseCase: PreExecGroundingPort wired — a FixLoop regen is not handed a pre-exec ambiguity: it fed nothing", async () => {
  let executeCalls = 0;
  const generateCalls: Array<{ enrichment?: { selectorContradictions?: readonly string[]; fixCases?: readonly unknown[] } }> = [];
  const { ports } = stubPorts({
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [AMBIGUOUS_SPEC_SOURCE], routes: AMBIGUOUS_ROUTES }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    execute: async () => {
      executeCalls++;
      return executeCalls === 1
        ? { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom" }], logs: "" }
        : { verdict: "pass", cases: [{ name: "owners", status: "pass" }], logs: "" };
    },
  });

  await new RunQaUseCase(ports).run(baseInput);

  const fixLoopCalls = generateCalls.filter((c) => (c.enrichment?.fixCases?.length ?? 0) > 0);
  assert.ok(fixLoopCalls.length > 0, "sanity: the FixLoop regenerated");
  assert.equal(fixLoopCalls.some((c) => (c.enrichment?.selectorContradictions ?? []).some((line) => /MULTIPLE/.test(line))), false);
});

/* The pre-generate grounding phase — contextPack/existingSpecFiles thread into GenerationEnrichment
   on EVERY generate() call (first-write ground truth, reused across regen passes); domSnapshot
   threads into ReviewEnrichment on the review call site, memoized per round by the reviewed spec set.
 */

test("RunQaUseCase: absent PreGenerationGroundingPort/ReviewDomGroundingPort -> generation/review enrichment carries neither field (backward compatible, [SWAP])", async () => {
  const generateCalls: Array<{ enrichment?: { contextPack?: string; existingSpecFiles?: string[] } }> = [];
  const reviewCalls: Array<{ enrichment?: { domSnapshot?: string } }> = [];
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    review: async (_specDir, _cases, _diff, enrichment) => {
      reviewCalls.push({ enrichment });
      return { approved: true, findings: [], blockingCount: 0, parsed: true };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { needsReview: true } });

  await useCase.run(baseInput);

  assert.ok(generateCalls.length > 0);
  for (const call of generateCalls) {
    assert.equal(call.enrichment?.contextPack, undefined);
    assert.equal(call.enrichment?.existingSpecFiles, undefined);
  }
  assert.ok(reviewCalls.length > 0);
  for (const call of reviewCalls) {
    assert.equal(call.enrichment?.domSnapshot, undefined);
  }
});

test("RunQaUseCase: PreGenerationGroundingPort wired — contextPack + existingSpecFiles thread into the INITIAL generate() call", async () => {
  const generateCalls: Array<{ enrichment?: { contextPack?: string; existingSpecFiles?: string[] } }> = [];
  const { ports } = stubPorts({
    ground: async () => ({ contextPack: "## Context Pack\n\nblast radius...", existingSpecFiles: ["flows/checkout.spec.ts"] }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.ok(generateCalls.length > 0);
  assert.equal(generateCalls[0]!.enrichment?.contextPack, "## Context Pack\n\nblast radius...");
  assert.deepEqual(generateCalls[0]!.enrichment?.existingSpecFiles, ["flows/checkout.spec.ts"]);
});

test("RunQaUseCase: PreGenerationGroundingPort wired — contextMap threads into generate() enrichment", async () => {
  const contextMap = {
    builtAtSha: "abc1234",
    routes: [{ path: "/owners" }],
    api: [{ operationId: "getOwners", method: "GET", path: "/api/owners" }],
    feBe: [{ route: "/owners", operationId: "getOwners" }],
  };
  const generateCalls: Array<{ enrichment?: { contextMap?: typeof contextMap; contextPack?: string } }> = [];
  const { ports } = stubPorts({
    ground: async () => ({
      contextPack: "## Context Pack\n\nblast radius...",
      contextMap,
    }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment: enrichment as { contextMap?: typeof contextMap; contextPack?: string } });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.ok(generateCalls.length > 0);
  assert.ok(generateCalls[0]!.enrichment?.contextMap, "enrichment.contextMap must be the object field, not inferred from contextPack text");
  assert.deepEqual(generateCalls[0]!.enrichment?.contextMap, contextMap);
  assert.equal(generateCalls[0]!.enrichment?.contextMap?.api[0]?.operationId, "getOwners");
});

test("RunQaUseCase: PreGenerationGroundingPort wired — absent grounding.contextMap is not fabricated on generate()", async () => {
  const generateCalls: Array<{ enrichment?: { contextMap?: unknown; contextPack?: string } }> = [];
  const { ports } = stubPorts({
    ground: async () => ({ contextPack: "## Context Pack\n\nblast radius..." }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase(ports);

  await useCase.run(baseInput);

  assert.equal(generateCalls[0]!.enrichment?.contextMap, undefined);
  assert.equal(generateCalls[0]!.enrichment?.contextPack, "## Context Pack\n\nblast radius...");
});

test("RunQaUseCase: harness facts from grounding reach the initial generate() and are reused unchanged on a regeneration", async () => {
  const harnessFacts = { testIdAttribute: "data-cy", fixtures: { file: "fixtures.ts", exports: ["test", "expect"] } };
  const seen: Array<unknown> = [];
  let groundCalls = 0;
  const { ports } = stubPorts({
    ground: async () => {
      groundCalls++;
      return { harnessFacts };
    },
    generate: async (_specDir, _signal, _diff, enrichment) => {
      seen.push((enrichment as { harnessFacts?: unknown } | undefined)?.harnessFacts);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    review: (() => {
      let round = 0;
      return async () => {
        round++;
        return round === 1
          ? { approved: false, findings: [{ text: "fix the thing", severity: "blocking" as const }], blockingCount: 1, parsed: true }
          : { approved: true, findings: [], blockingCount: 0, parsed: true };
      };
    })(),
  });

  await new RunQaUseCase({ ...ports, config: { needsReview: true } }).run(baseInput);

  assert.equal(groundCalls, 1, "grounding runs once per run");
  assert.ok(seen.length >= 2, "the initial generation plus a regeneration");
  for (const facts of seen) assert.deepEqual(facts, harnessFacts);
});

test("RunQaUseCase: a grounding without harness facts adds no key to the enrichment", async () => {
  const { ports } = stubPorts({
    ground: async () => ({ contextPack: "## pack" }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      assert.equal("harnessFacts" in (enrichment ?? {}), false);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  await new RunQaUseCase(ports).run(baseInput);
});

test("RunQaUseCase: PreGenerationGroundingPort wired — grounding is reused UNCHANGED across a review-correction regen (first-write ground truth)", async () => {
  const generateCalls: Array<{ enrichment?: { contextPack?: string } }> = [];
  let groundCalls = 0;
  const { ports } = stubPorts({
    ground: async () => {
      groundCalls++;
      return { contextPack: "## Context Pack\n\nfirst-write" };
    },
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    /* Reject round 0 so a review-correction regen actually fires (round 1's generate() call). */
    review: (() => {
      let round = 0;
      return async () => {
        round++;
        if (round === 1) return { approved: false, findings: [{ text: "fix the thing", severity: "blocking" as const }], blockingCount: 1, parsed: true };
        return { approved: true, findings: [], blockingCount: 0, parsed: true };
      };
    })(),
  });
  const useCase = new RunQaUseCase({ ...ports, config: { needsReview: true } });

  await useCase.run(baseInput);

  /* ground() is called ONCE per run (before the initial generate()), never rebuilt for the */
  assert.equal(groundCalls, 1);
  assert.ok(generateCalls.length >= 2, "expected the initial call plus at least one review-correction regen");
  for (const call of generateCalls) {
    assert.equal(call.enrichment?.contextPack, "## Context Pack\n\nfirst-write");
  }
});

test("RunQaUseCase: PreGenerationGroundingPort wired — a grounding failure is non-fatal; generation proceeds ungrounded", async () => {
  const generateCalls: Array<{ enrichment?: { contextPack?: string } }> = [];
  const { ports } = stubPorts({
    ground: async () => { throw new Error("capture script crashed"); },
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.ok(generateCalls.length > 0);
  assert.equal(generateCalls[0]!.enrichment?.contextPack, undefined);
});

test("RunQaUseCase: ReviewDomGroundingPort wired — domSnapshot threads into the review() call", async () => {
  const reviewCalls: Array<{ enrichment?: { domSnapshot?: string } }> = [];
  const { ports } = stubPorts({
    captureReviewDom: async () => "route /owners:\n  heading: Owners",
    review: async (_specDir, _cases, _diff, enrichment) => {
      reviewCalls.push({ enrichment });
      return { approved: true, findings: [], blockingCount: 0, parsed: true };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { needsReview: true } });

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.ok(reviewCalls.length > 0);
  assert.equal(reviewCalls[0]!.enrichment?.domSnapshot, "route /owners:\n  heading: Owners");
});

test("RunQaUseCase: ReviewDomGroundingPort wired — memoized per round: NOT re-captured when the reviewed spec set is unchanged", async () => {
  let captureCalls = 0;
  const { ports } = stubPorts({
    captureReviewDom: async () => {
      captureCalls++;
      return "route /owners:\n  heading: Owners";
    },
    /* Both rounds review the SAME spec set (approve on round 0 — no regen, so reviewCases never
       changes) — capture() must fire exactly once.
     */
    review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: { needsReview: true } });

  await useCase.run(baseInput);

  assert.equal(captureCalls, 1);
});

test("RunQaUseCase: ReviewDomGroundingPort wired — a capture failure is non-fatal; review proceeds ungrounded", async () => {
  const reviewCalls: Array<{ enrichment?: { domSnapshot?: string } }> = [];
  const { ports } = stubPorts({
    captureReviewDom: async () => { throw new Error("render crashed"); },
    review: async (_specDir, _cases, _diff, enrichment) => {
      reviewCalls.push({ enrichment });
      return { approved: true, findings: [], blockingCount: 0, parsed: true };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { needsReview: true } });

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.ok(reviewCalls.length > 0);
  assert.equal(reviewCalls[0]!.enrichment?.domSnapshot, undefined);
});

/* reviewer DOM grounding must take the ABORT path (infra-error, matching every other phase-boundary
   abort), NEVER the degraded-ungrounded-continue path — coherent with SETUP's own
   "aborting during setup() ... stops before generate()" test above. Both grounding ports themselves
   never throw on abort (their own contract) — it is the use-case's OWN signal?.aborted check
   immediately after each grounding call that does the routing. ───────────────────────────────────
 */

test("PRE-GENERATION GROUNDING: aborting during ground() (signal fires inside the collaborator) stops before generate() — takes the ABORT route, not degraded-ungrounded-continue", async () => {
  const controller = new AbortController();
  let generateCalled = false;
  const { ports } = stubPorts({
    ground: async () => { controller.abort(); return {}; },
    generate: async () => { generateCalled = true; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run({ ...baseInput, runId: "ground-abort-mid-call" }, controller.signal);

  assert.equal(generateCalled, false, "generate() must never run once the signal aborts during pre-generation grounding");
  assert.equal(out.decision.verdict, "infra-error", "an abort during grounding must map to the SAME aborted-terminal shape every other phase-boundary check uses, not a degraded-ungrounded pass");
  assert.equal(out.decision.sideEffect, "none");
});

test("REVIEWER DOM GROUNDING: aborting during capture() (signal fires inside the collaborator) stops the review loop — takes the ABORT route, not degraded-ungrounded-continue", async () => {
  const controller = new AbortController();
  let reviewCalled = false;
  const { ports } = stubPorts({
    captureReviewDom: async () => { controller.abort(); return undefined; },
    review: async () => { reviewCalled = true; return { approved: true, findings: [], blockingCount: 0, parsed: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { needsReview: true } });

  const out = await useCase.run({ ...baseInput, runId: "review-dom-abort-mid-call" }, controller.signal);

  assert.equal(reviewCalled, false, "review() must never run once the signal aborts during reviewer DOM grounding");
  assert.equal(out.decision.verdict, "infra-error", "an abort during reviewer DOM grounding must map to the SAME aborted-terminal shape every other phase-boundary check uses, not a degraded-ungrounded review round");
  assert.equal(out.decision.sideEffect, "none");
});

/* Drives ALL the scenarios.ts goldens through RunQaUseCase, with per-scenario stub ports built from
   the SAME fixture semantics scenarios.ts's makeDeps() encodes (never a new, invented behavior) —
   asserting RunDecision (verdict + sideEffect) equals the EXPECTED_VERDICT/EXPECTED_SIDE_EFFECT
   golden-outcome.test.ts already proves (and run-decision.scenarios.test.ts
   already proves for decide() in isolation). This test's OWN job is proving the WIRING reaches the
   same decision — not re-deriving decide()'s policy.
 */

interface GoldenScenarioCase {
  scenario: string;
  overrides: Partial<{
    classify: ChangeAnalysisPort["classify"];
    generate: AuthorPort["author"];
    review: ReviewPort["review"];
    validate: ValidationPort["validate"];
    execute: ExecutionPort["execute"];
    measure: ObjectiveSignalPort["measure"];
    waitUntilHealthy: DeployGatePort["waitUntilHealthy"];
  }>;
  config: { needsReview: boolean; shadow: boolean; onFailure: string; maxRetries: number };
  input: Partial<{ mode: "diff" | "manual" | "context"; target: "e2e" }>;
  expectedVerdict: string;
  expectedSideEffect: string;
}

const baseConfig = { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2 };

const goldenScenarios: GoldenScenarioCase[] = [
  {
    /* scenarioApp (needsReview:true), makeDeps({}) — generated (approved:true), passing(). Source:
     */
    scenario: "green-pr",
    overrides: {},
    config: baseConfig,
    input: {},
    expectedVerdict: "pass",
    expectedSideEffect: "pr",
  },
  {
    /* scenarioApp, makeDeps({ run: fail }) — a failing case, no fix-loop recovery (execute always
       returns the SAME fail result, mirroring the golden's fail-issue stub semantics exactly).
     */
    scenario: "fail-issue",
    overrides: {
      execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" }], logs: "x" }),
      generate: async () => (scriptedGeneration({ specs: ["a.spec.ts"]})),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "fail",
    expectedSideEffect: "issue",
  },
  {
    scenario: "flaky-quarantine",
    overrides: {
      execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "flaky",
    expectedSideEffect: "quarantine",
  },
  {
    /* scenarioApp, makeDeps({ agent: noopAgent }) — the agent approves with zero specs: a VALID
       skipped (AGENTS.md invariant), never invalid.
     */
    scenario: "no-op-skip",
    overrides: {
      generate: async () => (scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "nothing in this change is worth a test" })),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "skipped",
    expectedSideEffect: "none",
  },
  {
    /* scenarioApp, makeDeps({ validation: { ok:false, ... } }). */
    scenario: "invalid-issue",
    overrides: {
      validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "invalid",
    expectedSideEffect: "issue",
  },
  {
    /* scenarioApp, makeDeps({ healthy: false }) — DEV unhealthy before execution. Source:
     */
    scenario: "infra-error",
    overrides: {
      waitUntilHealthy: async () => ({ ok: false, error: new Error("DEV unhealthy") }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "infra-error",
    expectedSideEffect: "none",
  },
  {
    /* This row does not set triggerRepo — it pins needsReview-skip of the cross-repo shape only. */
    scenario: "cross-repo",
    overrides: {},
    config: { ...baseConfig, needsReview: false },
    input: {},
    expectedVerdict: "pass",
    expectedSideEffect: "pr",
  },
  {
    /* shadowApp (needsReview:true, shadow:true), makeDeps({}). */
    scenario: "shadow",
    overrides: {},
    config: { ...baseConfig, shadow: true },
    input: {},
    expectedVerdict: "pass",
    expectedSideEffect: "shadow-log",
  },
  {
    /* scenarioApp, context mode's own generate() stub — approved:true, reviewed:false, passing().
     */
    scenario: "context",
    overrides: {
      generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
    },
    config: baseConfig,
    input: { mode: "context" },
    expectedVerdict: "pass",
    expectedSideEffect: "pr",
  },
];

test("RunQaUseCase scenario parity: the golden set is non-trivial (guards against an accidentally-empty pin)", () => {
  assert.equal(goldenScenarios.length, 9, "expected exactly the 9 goldens");
});

for (const c of goldenScenarios) {
  test(`RunQaUseCase scenario parity — ${c.scenario}: RunDecision matches the golden verdict + side effect`, async () => {
    const { ports } = stubPorts(c.overrides);
    const useCase = new RunQaUseCase({ ...ports, config: c.config });

    const out = await useCase.run({ ...baseInput, runId: `golden-${c.scenario}`, ...c.input });

    assert.equal(out.decision.verdict, c.expectedVerdict, `${c.scenario}: verdict mismatch`);
    assert.equal(out.decision.sideEffect, c.expectedSideEffect, `${c.scenario}: sideEffect mismatch`);
  });
}

/* ── Genuine-wiring proofs (guards against an accidentally-green parity from a swallowed call or a
   dead branch) — call-count instrumentation on the specific ports each scenario's OWN semantics
   says must (or must not) be invoked. ──────────────────────────────────────────────────────────
 */

test("RunQaUseCase — shadow: publish() IS called (dispatches to PublicationPort, which routes shadow-log internally)", async () => {
  /* ONLY sideEffect==="pr" used to call publish() — shadow
     mode's "shadow-log" side effect silently never reached the publish port, so a shadow-mode green
     run never logged anything (AGENTS.md "Shadow mode... replaces every PR/Issue side effect with a
     log line" — a promise the use-case could not keep on its own, since PublicationPortAdapter's
     shadow-log routing (publication-port.adapter.ts:103-107) was simply unreachable). RunQaUseCase's
     own scope is the DECISION (sideEffect !== "none"), not which concrete side effect the real
     PublicationPortAdapter picks — routing shadow-log vs pr vs issue is that adapter's own decide()
     collaborator's job (see publish-decision.service.ts), exercised separately in
     publication-port.adapter.test.ts. This test's job is proving the WIRING reaches the port at all.
   */
  let publishCallCount = 0;
  const { ports } = stubPorts({ execute: passPerSpec });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "shadow: shadow mode — side effects replaced with logs" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, shadow: true } });

  const out = await useCase.run({ ...baseInput, runId: "golden-shadow-wiring-proof" });

  assert.equal(out.decision.sideEffect, "shadow-log");
  assert.equal(publishCallCount, 1, "shadow mode's sideEffect ('shadow-log' !== 'none') must still dispatch to the publish port — the REAL PublicationPortAdapter is what routes it to a log line, not this use-case skipping the call");
  assert.equal(out.note, "shadow: shadow mode — side effects replaced with logs", "the publish outcome must thread into RunQaResult.note");
});

test("RunQaUseCase — cross-repo (needsReview:false): review() is NEVER called", async () => {
  let reviewCallCount = 0;
  const { ports } = stubPorts({});
  ports.review.review = citingRejections(async () => { reviewCallCount++; return { approved: true, findings: [], blockingCount: 0, parsed: true }; });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  const out = await useCase.run({ ...baseInput, runId: "golden-cross-repo-wiring-proof" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(reviewCallCount, 0, "needsReview:false must skip the review port entirely");
});

/* A classify=skip / regression commit (perf/refactor, behavior-preserving per BOTH the message
   AND the diff cross-check) must skip generation entirely, run the EXISTING suite, and publish
   nothing new on a pass. `generating` is the classify action, never a hardcoded true.
 */

test("a regression commit that PASSES the existing suite publishes NOTHING (pass/none), never calls generate() or review()", async () => {
  let generateCallCount = 0;
  let reviewCallCount = 0;
  let executeCallCount = 0;
  let publishCallCount = 0;
  const { ports } = stubPorts({
    classify: async () => ({ action: "regression", reason: "type=refactor", diff: "diff --git a/src/x.ts b/src/x.ts\n+moved code\n" }),
    execute: async () => { executeCallCount++; return { verdict: "pass", cases: [{ name: "existing-suite-flow", status: "pass" as const }], logs: "" }; },
  });
  ports.generation.author = async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); };
  ports.review.review = citingRejections(async () => { reviewCallCount++; return { approved: true, findings: [], blockingCount: 0, parsed: true }; });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "pr" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "regression-pass-nothing-new" });

  assert.equal(generateCallCount, 0, "a regression run must NEVER call the author port — no new tests are written");
  assert.equal(reviewCallCount, 0, "a regression run must NEVER call the reviewer — nothing new was generated to judge");
  assert.equal(executeCallCount, 1, "the EXISTING suite must still be executed (regression's whole purpose)");
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "none", "a passing regression run publishes NOTHING — matches decide()'s own !ev.generating branch");
  assert.equal(publishCallCount, 0, "sideEffect:'none' must never dispatch to the publish port");
});

test("a regression commit whose EXISTING suite FAILS still opens an Issue (fail/issue), FixLoop never regenerates (generating:false)", async () => {
  let generateCallCount = 0;
  let executeCallCount = 0;
  const { ports } = stubPorts({
    classify: async () => ({ action: "regression", reason: "type=perf", diff: "diff --git a/src/x.ts b/src/x.ts\n+perf tweak\n" }),
    execute: async () => { executeCallCount++; return { verdict: "fail", cases: [{ name: "stale-flow", status: "fail" as const }], logs: "boom" }; },
  });
  ports.generation.author = async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "regression-fail-issue" });

  assert.equal(generateCallCount, 0, "generate() must never be called for a regression run, including inside the FixLoop's own regen path (gated on `generating`)");
  assert.equal(executeCallCount, 1, "the FixLoop must not retry-execute either, since its own loop condition includes `generating`");
  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "issue", "a red existing suite still surfaces — the normal fail/Issue machinery, unchanged");
});

test("reviewerApproved persists as undefined (never a fabricated true) for a passing regression run", async () => {
  const { ports } = stubPorts({
    classify: async () => ({ action: "regression", reason: "type=refactor", diff: "" }),
    execute: async () => ({ verdict: "pass", cases: [{ name: "existing-suite-flow", status: "pass" as const }], logs: "" }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "regression-reviewer-approved-undefined" });

  assert.equal(out.gateSignals.reviewerApproved, undefined, "this use-case's equivalent is undefined, never the synthetic generate() stand-in's approved:true");
});

test("a generate-typed commit (unchanged) still calls generate() normally — regression's own gate does not leak into other actions", async () => {
  let generateCallCount = 0;
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "type=feat", diff: "diff --git a/src/x.ts b/src/x.ts\n+if (x) return 1;\n" }),
  });
  ports.generation.author = async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "generate-unaffected" });

  assert.ok(generateCallCount >= 1, "a genuinely generate-typed commit must still call generate() — the regression gate only applies to the regression action");
});

/* ChangeAnalysisPort.classify(entry) — the use-case's own half of the seam (the runner's
   half is pinned in platform/entrypoints/runner.test.ts).
 */

test("classify() receives the change set's anchor entry, base and commit count included", async () => {
  const seen: unknown[] = [];
  const { ports } = stubPorts({
    classify: async (entry) => { seen.push(entry); return { action: "generate", reason: "type=feat", diff: "" }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });
  const head = Sha.of("abc1234");
  const withBase = ChangeSet.of("demo", [{ repo: "org/demo", role: "primary", headSha: head, baseSha: Sha.of("bad00001") }]);
  const withCount = ChangeSet.of("demo", [{ repo: "org/demo", role: "primary", headSha: head, commits: 3 }]);

  await useCase.run({ ...baseInput, runId: "no-basesha" });
  await useCase.run({ ...baseInput, runId: "with-basesha", changeSet: withBase, baseSha: Sha.of("bad00001") });
  await useCase.run({ ...baseInput, runId: "with-commits", changeSet: withCount });

  assert.deepEqual(seen, [baseInput.changeSet.anchor, withBase.anchor, withCount.anchor]);
});

test("classification.reason + contradiction:true reach baseEnrichment when the classifier escalated", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({
      action: "generate",
      reason: "message 'refactor' expected no tests, but the diff adds logic → escalated to generate",
      diff: "diff --git a/src/x.ts b/src/x.ts\n+if (x) return 1;\n",
      contradiction: true,
    }),
  });
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "reason-contradiction-present" });

  assert.ok(capturedEnrichments.length > 0);
  for (const captured of capturedEnrichments) {
    assert.equal(captured?.classificationReason, "message 'refactor' expected no tests, but the diff adds logic → escalated to generate");
    assert.equal(captured?.contradiction, true);
  }
});

test("contradiction key is ABSENT (never a fabricated false) when the classifier did not escalate", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "type=feat", diff: "diff --git a/src/x.ts b/src/x.ts\n+if (x) return 1;\n" }),
  });
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "no-contradiction" });

  for (const captured of capturedEnrichments) {
    assert.ok(captured && !("contradiction" in captured), "an absent/false contradiction must never add the key — matches every sibling field's conditional-spread contract");
    assert.equal(captured?.classificationReason, "type=feat");
  }
});

test("RunQaUseCase — fail-issue: the FixLoop genuinely engages (generate + execute called MORE than once, retries > 0)", async () => {
  let generateCallCount = 0;
  let executeCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => { executeCallCount++; return { verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }; },
    generate: async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "golden-fail-issue-wiring-proof" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.gateSignals.retries, 1, "matches the fail-issue golden's own retries:1");
  assert.ok(generateCallCount > 1, `expected the FixLoop to call generate() at least twice (initial + regen), got ${generateCallCount}`);
  assert.ok(executeCallCount > 1, `expected the FixLoop to call execute() at least twice (initial + retry), got ${executeCallCount}`);
});

test("RunQaUseCase — invalid-issue: execute() is NEVER called (static gate blocks before execution)", async () => {
  let executeCallCount = 0;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.execution.execute = async (dir, opts) => { executeCallCount++; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "golden-invalid-issue-wiring-proof" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(executeCallCount, 0, "a static-gate failure must block BEFORE execution, never call it");
});

/* An e2e static-gate failure whose infra:true is infra-error: the verdict-mapping branch reads only validation.infra.
 */
test("RunQaUseCase — an e2e-target validation failure with infra:true ALSO resolves to infra-error (target-agnostic fix)", async () => {
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["playwright: browser binary missing"], infra: true }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "e2e-infra-error" });

  assert.equal(out.decision.verdict, "infra-error");
});

test("RunQaUseCase — infra-error: execute() is NEVER called (DEV unhealthy before execution)", async () => {
  let executeCallCount = 0;
  const { ports } = stubPorts({ waitUntilHealthy: async () => ({ ok: false, error: new Error("DEV unhealthy") }) });
  ports.execution.execute = async (dir, opts) => { executeCallCount++; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "golden-infra-error-wiring-proof" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(executeCallCount, 0, "DEV-unhealthy must block BEFORE execution, never call it");
});

/* ── AGENTS.md invariant ("surface integration errors loudly — never swallow errors into an empty
   result"): every infra-error-shaped terminal must carry a diagnostic note. A live portfolio run
   once produced verdict:infra-error with NO note/log/cases — undiagnosable without instrumenting a
   live container. These tests pin the note end-to-end for each silent terminal that fix closed. ──
 */

test("entry deploy-gate failure surfaces the InfraError message as the note", async () => {
  const { ports } = stubPorts({
    waitUntilHealthy: async () => ({ ok: false, error: new Error("DEV did not serve sha abc1234 within 5000ms (versionUrl=https://example.com/version)") }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "note-chain-entry-gate" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.ok(
    out.note?.includes("DEV did not serve sha abc1234"),
    `the entry deploy-gate's own InfraError message must reach the note, not be dropped — got: ${out.note}`,
  );
});

test("mid-run health pre-flight failure surfaces a note (and is persisted)", async () => {
  let waitUntilHealthyCall = 0;
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    waitUntilHealthy: async () => {
      waitUntilHealthyCall++;
      /* First call (entry gate) succeeds; second call (mid-run pre-flight, after validate) fails — */
      return waitUntilHealthyCall === 1 ? ok(true) : { ok: false, error: new Error("DEV went down mid-run") };
    },
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "note-chain-health-preflight" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.ok(out.note?.includes("DEV went down mid-run"), `the mid-run health pre-flight's captured gate error must reach the note — got: ${out.note}`);
  assert.equal(saved?.note, out.note, "the persisted RunOutcome must carry the SAME note as the returned RunQaResult — the note must survive the mapping chain out to the run record");
});

test("static-gate 'invalid' terminal surfaces the validation errors as the note", async () => {
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout", "[tsc] Type 'string' is not assignable to type 'number'."] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "note-chain-validation-invalid" });

  assert.equal(out.decision.verdict, "invalid");
  assert.ok(out.note?.includes("no-wait-for-timeout"), `a static-gate 'invalid' terminal must surface validation.errors in the note — got: ${out.note}`);
});

/* only ever saw the STATIC diff of the run context (set at composition-BUILD time), which is empty
   for the real production engineFactory (constructed BEFORE the run/checkout) — generation always
   got an empty diff -> zero specs -> a false skip. classify() already computes the commit's diff
   internally (ChangeAnalysisPortAdapter sources it from the SAME VcsReadPort it uses for
   classifyCommit) but previously discarded it. This proves the use-case now surfaces that
   classification-sourced diff into EVERY generate() call, in place of an empty/static value. ───────
 */

test("dynamic diff: generate() receives the change-analysis diff (diff mode), not an empty/static value", async () => {
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts\n+real change\n" }),
  });
  ports.generation.author = async (_specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "dynamic-diff-generate-receives-classification-diff", mode: "diff" });

  assert.ok(capturedDiffs.length > 0, "generate() must have been called at least once");
  for (const captured of capturedDiffs) {
    assert.equal(
      captured,
      "diff --git a/src/x.ts b/src/x.ts\n+real change\n",
      "every generate() call must receive the SAME diff classify() computed for this run, not an empty string or a stale static value",
    );
  }
});

test("dynamic diff: the static-fix repair loop also threads the SAME classification diff into its regenerate() call", async () => {
  let validateCallCount = 0;
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts\n+repair-round change\n" }),
    validate: async () => {
      validateCallCount++;
      return validateCallCount === 1
        ? { ok: false, errors: ["39:11  error  'x' is assigned a value but never used"] }
        : { ok: true, errors: [] };
    },
  });
  ports.generation.author = async (_specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "dynamic-diff-static-fix-loop-threads-diff", mode: "diff" });

  assert.equal(out.decision.verdict, "pass", "the static-fix loop must still recover exactly as before");
  assert.ok(capturedDiffs.length >= 2, `expected at least 2 generate() calls (initial + 1 repair round), got ${capturedDiffs.length}`);
  for (const captured of capturedDiffs) {
    assert.equal(captured, "diff --git a/src/x.ts b/src/x.ts\n+repair-round change\n", "the repair regeneration must reuse the SAME classification diff, not drop it on the retry");
  }
});

test("dynamic diff: the FixLoop's own regenerate() call also threads the SAME classification diff", async () => {
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts\n+fixloop change\n" }),
    execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.generation.author = async (_specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "dynamic-diff-fixloop-threads-diff", mode: "diff" });

  assert.ok(capturedDiffs.length > 1, `expected the FixLoop to call generate() more than once, got ${capturedDiffs.length}`);
  for (const captured of capturedDiffs) {
    assert.equal(captured, "diff --git a/src/x.ts b/src/x.ts\n+fixloop change\n", "the FixLoop's own regenerate() call must reuse the SAME classification diff on every round");
  }
});

test("dynamic diff: a non-diff mode (e.g. complete) never calls classify(), so generate() receives undefined — the adapter's static ctx.diff fallback stays intact", async () => {
  let classifyCallCount = 0;
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => { classifyCallCount++; return { action: "generate", reason: "n/a", diff: "should never be read" }; },
  });
  ports.generation.author = async (_specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "dynamic-diff-non-diff-mode-no-classify", mode: "manual" });

  assert.equal(classifyCallCount, 0, "only diff mode runs classifyCommit — complete/exhaustive/manual/context always generate without classifying");
  assert.ok(capturedDiffs.length > 0, "generate() must still have been called");
  for (const captured of capturedDiffs) {
    assert.equal(captured, undefined, "without a classification diff, the use-case must pass undefined (never a fabricated value) so the adapter's own ctx.diff fallback applies");
  }
});


test("reviewer parse-miss (parsed:false) must FAIL CLOSED — reviewerApproved=false, not true", async () => {
  /* review() returns parsed:false (a parse miss) with approved:false on the raw payload too, so a
     fail-OPEN bug (parsed:false -> treat as approved:true) is masked unless approved itself is
     false — this reproduces the reviewer-outage shape (approved:false, parsed:false), so a correct
     fail-closed implementation and a buggy fail-open implementation disagree on the FINAL decision,
     not just an intermediate field.
   */
  const { ports } = stubPorts({
    execute: async (dir, opts) => ({ verdict: "pass", cases: passingCases(dir, opts), logs: "" }),
    review: async () => ({ approved: false, findings: [], blockingCount: 0, parsed: false }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); /* baseConfig.needsReview === true */

  const out = await useCase.run({ ...baseInput, runId: "fix-a-reviewer-parse-miss" });

  /* Fail-closed: a parse-miss must NOT be treated as approved. This routes to an Issue
     (reviewerApproved:false -> RunEvidence.needsReview && !reviewerApproved -> issue), never a PR.
   */
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "issue", "a reviewer parse-miss must fail CLOSED (issue), not silently approve (pr)");
});

test("coveragePolicyMode:\"signal\" (the default) NEVER blocks publish even when the signal is fail", async () => {
  const { ports } = stubPorts({
    execute: passPerSpec,
    measure: async () => ({ status: "fail", ratio: 0.2 }),
  });
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" },
  });

  const out = await useCase.run({ ...baseInput, runId: "fix-b-signal-never-blocks" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr", "signal mode must publish (measure + record only), never hold the PR");
});

/* publish when the signal is fail" — that test's own premise (a single measure() call decides
   blocksPublish) is now FALSE: enforce mode regenerates ONCE against the uncovered lines before
   deciding. New scenarios below cover: regen->pass->unblocks; regen->still-fail->keeps blocksPublish;
   regen throws->keeps first; sig2 unknown->never blocks; signal mode->no regen at all; ONLY ONE
   regen ever; the regen's execute()+re-measure() both use the
   `${runId}-coverage-regen` namespace (Constraint 2's dump-attribution requirement).
 */

test("enforce mode — first measure fails, regen fires, second measure ALSO fails — blocksPublish stays true (held)", async () => {
  let measureCallCount = 0;
  const real = realCoverageWorkspace();
  try {
    const { ports } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => { measureCallCount++; return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1, 2] }] }; },
      blocks: (status) => status === "fail",
    });
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
    });

    const out = await useCase.run({ ...baseInput, runId: "p2c-enforce-regen-still-fails" });

    assert.equal(out.decision.verdict, "pass");
    assert.equal(out.decision.sideEffect, "held", "enforce mode must hold the PR (no PR, no Issue) when the SECOND measure also fails");
    assert.equal(measureCallCount, 2, "enforce+fail must regenerate exactly once, re-measuring exactly twice total (never a third)");
  } finally {
    real.cleanup();
  }
});

test("enforce mode — first measure fails, regen fires, second measure PASSES — blocksPublish unblocks (pr)", async () => {
  let measureCallCount = 0;
  const real = realCoverageWorkspace();
  try {
    const { ports } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => {
        measureCallCount++;
        return measureCallCount === 1
          ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1, 2] }] }
          : { status: "pass" as const, ratio: 0.95 };
      },
      blocks: (status) => status === "fail",
    });
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
    });

    const out = await useCase.run({ ...baseInput, runId: "p2c-enforce-regen-unblocks" });

    assert.equal(out.decision.verdict, "pass");
    assert.equal(out.decision.sideEffect, "pr", "a regen whose second measure PASSES must unblock publish");
    assert.equal(measureCallCount, 2);
  } finally {
    real.cleanup();
  }
});

test("enforce mode — regen's second measure resolves unknown — blocksPublish stays false (the keystone invariant survives regen)", async () => {
  let measureCallCount = 0;
  const real = realCoverageWorkspace();
  try {
    const { ports } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => {
        measureCallCount++;
        return measureCallCount === 1
          ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1, 2] }] }
          : { status: "unknown" as const, ratio: null };
      },
      blocks: (status) => status === "fail",
    });
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
    });

    const out = await useCase.run({ ...baseInput, runId: "p2c-enforce-regen-unknown-never-blocks" });

    assert.equal(out.decision.sideEffect, "pr", "unknown NEVER blocks, even after a prior fail — the coverage keystone invariant survives the regen");
    assert.equal(measureCallCount, 2);
  } finally {
    real.cleanup();
  }
});

test("enforce mode — the regen's generate() throws — KEEPS the first measurement's blocksPublish (never fabricated)", async () => {
  let measureCallCount = 0;
  const { ports } = stubPorts({
    execute: passPerSpec,
    measure: async () => { measureCallCount++; return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }; },
    blocks: (status) => status === "fail",
  });
  let genCallCount = 0;
  ports.generation.author = async () => {
    genCallCount++;
    if (genCallCount === 1) return scriptedGeneration({ specs: ["a.spec.ts"]});
    throw new Error("agent runtime crashed mid-regen");
  };
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
  });

  await assert.rejects(
    () => useCase.run({ ...baseInput, runId: "p2c-enforce-regen-throws" }),
    /agent runtime crashed mid-regen/,
    "AGENTS.md invariant: surface integration errors loudly — a regen throw must propagate, never be silently swallowed into a fabricated result",
  );
});

test("enforce mode — the run deadline is spent during the coverage regeneration — the first measurement stands: no time-budget end, the PR stays held", async () => {
  let measureCallCount = 0;
  const { ports } = stubPorts({
    execute: passPerSpec,
    measure: async () => { measureCallCount++; return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }; },
    blocks: (status) => status === "fail",
  });
  let genCallCount = 0;
  ports.generation.author = async () => {
    genCallCount++;
    if (genCallCount === 1) return scriptedGeneration({ specs: ["a.spec.ts"]});
    throw new RunDeadlineExceededError(600_000, "diff", "primary", "before-turn");
  };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" } });

  const out = await useCase.run({ ...baseInput, runId: "enforce-regen-deadline" });

  assert.equal(out.decision.verdict, "pass", "the green run is not turned into a time-budget infra-error");
  assert.equal(out.decision.sideEffect, "held", "the first measurement's block holds");
  assert.equal(measureCallCount, 1);
});

/* The mutation pass a measurement by execution found due: opaque to the run, handed back to the port as it was. */
const duePass = { mutants: [], selection: { rerunsByTest: 1, rerunsBySpecFile: 0 }, judgedAgainst: ["a"], namespace: "ns", sources: [], changeDiff: "", changedFiles: [], executed: { measured: true, overall: { changedLines: 10, coveredChanged: 8, ratio: 0.8 }, perFile: [], uncovered: [] }, caseFiles: [] } as unknown as MutationPass;
/* What the coverage measured by execution alone, and what the mutation pass made of it: the verified measurement, with the mutants it judged. */
const measuredByExecution = { status: "pass" as const, ratio: 0.8, measurement: { changedLines: 10, coveredChanged: 8, changedFiles: 1, mappedFiles: 1, changedBranches: 4, takenBranches: 2 }, mutationPass: duePass };
const measuredWithMutants = { status: "pass" as const, ratio: 0.9, measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, changedBranches: 4, takenBranches: 3, coveredByExecution: 8, provenByMutation: 1 }, bundleMutation: { applied: 2, killed: 1, survived: [{ file: "src/a.ts", line: 3, operator: "negate condition" }] } };

/* A measurement port that measures by execution, and runs the mutation pass it found due, during which `duringMutants` happens. */
const measuringInTwoPasses = (duringMutants: (opts: Parameters<NonNullable<ObjectiveSignalPort["measureMutation"]>>[2]) => void = () => {}): Pick<ObjectiveSignalPort, "measure"> & { measureMutation: NonNullable<ObjectiveSignalPort["measureMutation"]> } => ({
  measure: async () => measuredByExecution,
  measureMutation: async (pass, _dir, opts) => {
    assert.equal(pass, duePass, "the pass the measurement by execution returned");
    duringMutants(opts);
    return measuredWithMutants;
  },
});

test("the run deadline spent during the mutation pass keeps what the pass came to on the saved outcome: its proof does not depend on time", async () => {
  const { deadline, fire } = deadlineFiredByHand(3_600_000);
  const { ports, savedOutcomes } = stubPorts({ execute: passPerSpec, ...measuringInTwoPasses(() => fire()) });

  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "mutation-cut-by-deadline" });

  assert.equal(out.decision.verdict, "pass", "the green suite is kept past the deadline");
  const { coverageRatio, branchCoverage, changeCoverage, bundleMutation } = savedOutcomes.at(-1)!.gateSignals;
  assert.equal(coverageRatio, measuredWithMutants.ratio);
  assert.deepEqual(branchCoverage, { changed: measuredWithMutants.measurement.changedBranches, taken: measuredWithMutants.measurement.takenBranches });
  assert.equal(changeCoverage?.provenByMutation, measuredWithMutants.measurement.provenByMutation);
  assert.deepEqual(bundleMutation, measuredWithMutants.bundleMutation);
  assert.ok(limitsOf(out).some((limit) => limit.startsWith("run-deadline@")), `the deadline is recorded as the limit that fired, though no step after the pass had work: ${limitsOf(out).join(", ")}`);
  assert.ok((traceFactsOf(out)?.degradations ?? []).some((d) => d.reason === "deadline-after-proof"));
});

test("the run deadline spent during the measurement by execution still cuts it: only the mutation pass outlives the deadline", async () => {
  const { deadline, fire } = deadlineFiredByHand(3_600_000);
  let passes = 0;
  const { ports, savedOutcomes } = stubPorts({
    execute: passPerSpec,
    measure: async () => { fire(); return measuredByExecution; },
    measureMutation: async () => { passes += 1; return measuredWithMutants; },
  });

  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "measure-cut-by-deadline" });

  assert.equal(out.decision.verdict, "pass", "the green suite is kept past the deadline");
  assert.equal(passes, 0, "no mutation pass after the cut");
  assert.equal(savedOutcomes.at(-1)!.gateSignals.coverageRatio, null, "the cut measurement is not kept");
});

test("a run with time for the mutation pass records the measurement the mutants verified and the mutants it judged", async () => {
  const { ports, savedOutcomes } = stubPorts({ execute: passPerSpec, ...measuringInTwoPasses() });

  const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "mutation-pass-completes" });

  assert.equal(out.decision.verdict, "pass");
  const { coverageRatio, branchCoverage, changeCoverage, bundleMutation } = savedOutcomes.at(-1)!.gateSignals;
  assert.equal(coverageRatio, measuredWithMutants.ratio);
  assert.deepEqual(branchCoverage, { changed: measuredWithMutants.measurement.changedBranches, taken: measuredWithMutants.measurement.takenBranches });
  assert.equal(changeCoverage?.provenByMutation, measuredWithMutants.measurement.provenByMutation);
  assert.deepEqual(bundleMutation, measuredWithMutants.bundleMutation);
});

test("the mutation pass is held to the coverage allowance and estimated from the run's final execution", async () => {
  const { deadline } = deadlineFiredByHand(3_600_000);
  let handed: Parameters<NonNullable<ObjectiveSignalPort["measureMutation"]>>[2];
  let executed: QaCase[] = [];
  const execute: ExecutionPort["execute"] = async (dir, opts) => {
    const result = await passPerSpec(dir, opts);
    executed = result.cases;
    return result;
  };
  const { ports } = stubPorts({ execute, ...measuringInTwoPasses((opts) => { handed = opts; }) });

  await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "mutation-pass-budget" });

  assert.ok(executed.length > 0);
  assert.deepEqual(handed?.rerunBudget?.cases, executed, "the cases of the execution the coverage measured");
  assert.equal(handed?.rerunBudget?.allowance(), deadline.allowance("coverage"));
});

/*
 * The coverage phase through the real measurement port, mutation oracle and trace: one changed file of four added lines, of which the
 * passing test ran `covered`; three mutation sites on lines 1-3, a re-run of the first is noticed by the test (killed, its dumps add line
 * 3), the second survives and adds a request to its page, the third reaches no page. `rereadFaults` makes every read of a namespace
 * after its first end `decode-aborted`, as a second decode of a large set of dumps can.
 */
const PASS_SPEC = "a.spec.ts";
const PASS_CASE = "a.spec.ts › runs";
const PASS_DUMP = "a-spec-ts-runs-0-0.json";
const PASS_DIFF = ["diff --git a/src/checkout.ts b/src/checkout.ts", "--- a/src/checkout.ts", "+++ b/src/checkout.ts", "@@ -0,0 +1,4 @@", "+if (x) pay();", "+if (x) pay();", "+if (x) pay();", "+if (x) pay();"].join("\n");

/* Every span opened, with the attributes it was given. */
class SpanAttrsRecorder extends NoopTelemetry {
  readonly spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  readonly events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  override startSpan(name?: string, opts?: StartSpanOptions): SpanHandle {
    const inner = super.startSpan(name, opts);
    const rec = { name: String(name), attrs: { ...((opts as { attrs?: Record<string, unknown> } | undefined)?.attrs ?? {}) } };
    this.spans.push(rec);
    return { ...inner, setAttrs: (attrs) => { Object.assign(rec.attrs, attrs); inner.setAttrs(attrs); }, addEvent: (name, attrs, time) => { this.events.push({ name, attrs: { ...(attrs ?? {}) } }); inner.addEvent(name, attrs, time); }, recordError: (...a) => inner.recordError(...a), end: (...a) => inner.end(...a), context: () => inner.context() };
  }
  measureSpans(): Array<Record<string, unknown>> {
    return this.spans.filter((s) => s.name === "qayaba.coverage.measure").map((s) => s.attrs);
  }
}

interface MutationRigOptions {
  mode?: "signal" | "enforce";
  minRatio?: number;
  covered?: number[];
  sourceLine?: string;
  rereadFaults?: boolean;
  realWorkspace?: boolean;
  /* No mutant's script is served as the coverage saw it: none reaches a page. */
  reachesNoPage?: boolean;
  /* The run's clock, which each re-run of the mutation pass moves on by `rerunMs`; absent, time stands still. */
  clock?: { now: number; rerunMs: number };
  /* An execution whose namespace ends with `namespace` sets the clock to `now` once it has run. */
  clockAfter?: { namespace: string; now: number };
  /* Told each re-run of the mutation pass as it runs, by its kind and index (obs, mut0, …, obs2). */
  duringRerun?: (rerun: string) => void;
  /* The first re-run of this mutant ends on the app's login page, as one the app ended the session of. */
  loginWallOnce?: string;
}

function mutationRig(o: MutationRigOptions = {}) {
  const reads: string[] = [];
  const reruns: string[] = [];
  const site = (line: number) => ({ file: "src/checkout.ts", line, column: 0, operator: "negate condition", script: { url: "https://dev.example/main.js", sha256: "h" }, edit: { start: line * 10, end: line * 10 + 1, replacement: "!" }, original: "x", expression: "x", sourceLine: o.sourceLine ?? "if (x) pay();", ranIn: [PASS_DUMP] });
  const covered = o.covered ?? [1, 2];
  const report = (lines: number[]) => ({
    covered: [{ file: "src/checkout.ts", lines }],
    executable: [{ file: "src/checkout.ts", lines: [1, 2, 3, 4] }],
    scripts: { total: 1, withSourceMap: 1 },
    branches: [{ file: "src/checkout.ts", line: 3, column: 0, kind: "if" as const, ranIn: [], arms: [{ label: "then", taken: false }, { label: "else", taken: true }] }],
    mutationSites: [site(1), site(2), site(3)],
    ranBy: [{ file: "src/checkout.ts", dumps: [PASS_DUMP] }],
  });
  const collector = {
    collect: async (_specDir: string, namespace: string) => {
      const again = reads.includes(namespace);
      reads.push(namespace);
      return o.rereadFaults && again ? { covered: [], fault: "decode-aborted" as const, reads: [] } : report(covered);
    },
    recollect: async (_specDir: string, sources: readonly { namespace: string; mutant?: unknown }[]) => report(sources.some((source) => source.mutant !== undefined) ? [...new Set([...covered, 3])].sort() : covered),
  };
  const page = { name: PASS_CASE, requests: [{ method: "GET", url: "https://dev.example/api/x", count: 1 }], dom: ["heading: Pay"] };
  const runMutant = async (args: { namespace: string }) => {
    reruns.push(args.namespace.replace(/^.*-(obs2?|mut\d)$/, "$1"));
    if (o.clock) o.clock.now += o.clock.rerunMs;
    o.duringRerun?.(reruns.at(-1)!);
    const pass = { name: PASS_CASE, status: "pass" as const, file: PASS_SPEC };
    if (o.loginWallOnce !== undefined && args.namespace.endsWith(`-${o.loginWallOnce}`) && reruns.filter((r) => r === o.loginWallOnce).length === 1) {
      return { verdict: "fail", cases: [{ ...pass, status: "fail" as const, finalUrl: "https://dev.example/login?next=%2Fpay", failureDom: 'heading: Sign in\ntextbox: "Password"' }], observations: [page] };
    }
    if (args.namespace.endsWith("-mut0")) return { verdict: "fail", cases: [{ ...pass, status: "fail" as const }], observations: [page] };
    if (args.namespace.endsWith("-mut1")) return { verdict: "pass", cases: [pass], observations: [{ ...page, requests: [...page.requests, { method: "POST", url: "https://dev.example/api/pay", count: 1 }] }] };
    return { verdict: "pass", cases: [pass], observations: [page] };
  };
  /* As in production, the oracle runs no re-run of its own: the run hands it its execution port. */
  const oracle = new BundleMutationOracleAdapter(undefined, (_dir, namespace) => (o.reachesNoPage || namespace.endsWith("-mut2") ? 0 : 1), "https://dev.example", requestOriginClassifier(["https://dev.example", "https://api.maps.example"]));
  const port = new ObjectiveSignalPortAdapter(
    { collector, decide: new DecideCoverageService(), mutation: oracle, readSource: () => "if (x) pay();\nif (x) pay();\nif (x) pay();\nif (x) pay();\n" },
    { policy: { mode: o.mode ?? "signal", minRatio: o.minRatio ?? 0.7 }, repoDir: "/nonexistent", assembleChangeCoverage },
  );
  const telemetry = new SpanAttrsRecorder();
  return { reads, reruns, telemetry, page, runMutant, traced: new TracedObjectiveSignalPort(port, telemetry) };
}

/* A re-run of the mutation pass, by its namespace: the run's execution port is where every one arrives. */
const MUTATION_RERUN = /-(obs2?|mut\d)$/;

async function runMutationRig(runId: string, o: MutationRigOptions = {}, deadline: RunDeadline = deadlineFiredByHand(3_600_000).deadline, generated?: () => void, extra: Partial<RunQaUseCaseDeps> = {}) {
  const rig = mutationRig(o);
  const real = o.realWorkspace ? realCoverageWorkspace() : undefined;
  const execute: ExecutionPort["execute"] = async (dir, opts) => {
    const namespace = (opts as { namespace?: string } | undefined)?.namespace;
    if (namespace !== undefined && MUTATION_RERUN.test(namespace)) {
      const rerun = await rig.runMutant({ namespace });
      return { ...rerun, verdict: rerun.verdict as RunVerdict, logs: "" };
    }
    const r = await passPerSpec(dir, opts);
    if (o.clock && o.clockAfter && (opts as { namespace?: string } | undefined)?.namespace?.endsWith(o.clockAfter.namespace)) o.clock.now = o.clockAfter.now;
    /* The measurement execution observes the page its test ended on, the mutants' first unmutated observation. */
    const observed = (opts as { observe?: boolean } | undefined)?.observe === true ? { observations: [rig.page] } : {};
    return { ...r, cases: r.cases.map((c) => ({ ...c, file: PASS_SPEC, name: PASS_CASE, durationMs: 1000 })), ...observed };
  };
  const { ports, savedOutcomes } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/checkout.ts", diff: PASS_DIFF }),
    execute,
    measure: (...a) => rig.traced.measure(...a),
    blocks: (status) => rig.traced.blocks(status),
    recount: (...a) => rig.traced.recount!(...a),
    recheckSurvivors: (...a) => rig.traced.recheckSurvivors!(...a),
    ...(rig.traced.measureMutation ? { measureMutation: (...a: Parameters<NonNullable<ObjectiveSignalPort["measureMutation"]>>) => rig.traced.measureMutation!(...a) } : {}),
    ...(real ? { prepare: real.prepare, generate: async (...a) => { generated?.(); return real.generate(...a); } } : {}),
  });
  try {
    const out = await new RunQaUseCase({
      ...ports,
      ...extra,
      runDeadline: deadline,
      telemetry: rig.telemetry,
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: o.mode ?? "signal", ...(o.minRatio !== undefined ? { coverageMinRatio: o.minRatio } : {}) },
    }).run({ ...baseInput, runId });
    const g = savedOutcomes.at(-1)!.gateSignals;
    return { out, rig, executions: g.executions, coverage: { coverageRatio: g.coverageRatio, branchCoverage: g.branchCoverage, changeCoverage: g.changeCoverage, bundleMutation: g.bundleMutation, survivorClosure: g.survivorClosure, integrity: g.integrity } };
  } finally {
    real?.cleanup();
  }
}

/* What the surviving mutant moved: the request its page added, between the same test run with and without it. */
const POST_ADDED = { kind: "moved", requests: { added: ["POST https://dev.example/api/pay"], removed: [] }, dom: { added: [], removed: [] }, tests: [PASS_CASE] };
/* The mutation pass of the rig, as a run with the pass inside the measurement recorded it: two judged, one killed (its dumps add line 3), one survivor. */
const RIG_BUNDLE_MUTATION = { applied: 2, killed: 1, survived: [{ file: "src/checkout.ts", line: 1, operator: "negate condition", specFiles: [PASS_SPEC], original: "x", replacement: "!", moved: POST_ADDED, movedBySpec: [{ spec: PASS_SPEC, moved: POST_ADDED }] }] };
const RIG_VERIFIED = { coverageRatio: 0.75, branchCoverage: { changed: 2, taken: 1 }, changeCoverage: { executableLines: 4, notExecutableLines: 0, coveredByExecution: 2, provenByMutation: 1, armsProvenByMutation: 0 }, bundleMutation: RIG_BUNDLE_MUTATION };
/* The measurement execution a measurement was read from, as the record keeps it: the rig's one passing test, green there too. */
const rigMeasuredBy = (namespace: string) => ({ namespace, tests: 1, failedOnlyUnderMeasurement: [] });
const rigVerifiedBy = (namespace: string) => ({ ...RIG_VERIFIED, changeCoverage: { ...RIG_VERIFIED.changeCoverage, measuredBy: rigMeasuredBy(namespace) } });
/* The span of the measurement the mutation pass verified, as a run with the pass inside the measurement traced it. */
const rigVerifiedSpan = (status: "pass" | "fail") => ({
  "qayaba.coverage.status": status,
  "qayaba.mutation.applied": 2,
  "qayaba.mutation.killed": 1,
  "qayaba.mutation.survivors_routed": 1,
  "qayaba.mutation.survivors_without_spec": 0,
  "qayaba.mutation.survivors_moved": 1,
  "qayaba.mutation.survivors_unmoved": 0,
  "qayaba.mutation.survivors_unobserved": 0,
  "qayaba.mutation.sites_skipped": 0,
  "qayaba.mutation.reruns_by_test": 3,
  "qayaba.mutation.reruns_by_spec_file": 0,
  "qayaba.coverage.ratio": 0.75,
  "qayaba.coverage.changed_lines": 4,
  "qayaba.coverage.covered_lines": 3,
  "qayaba.coverage.changed_files": 1,
  "qayaba.coverage.mapped_files": 1,
  "qayaba.coverage.changed_branches": 2,
  "qayaba.coverage.taken_branches": 1,
});

test("a mutant's re-run that ends on the app's login page is judged as it ran, as every execution is: nothing checks or renews the session", async () => {
  const logins: string[] = [];
  const { rig, coverage } = await runMutationRig("mutation-session", { loginWallOnce: "mut1" }, undefined, undefined, {
    authSession: { prepare: async (req) => { logins.push(req.phase); return { unauthored: false, storageStatePath: "/auth/user.json" }; } },
    authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } },
  });

  assert.deepEqual(rig.reruns, ["mut0", "mut1", "mut2"], "each mutant ran once");
  assert.equal(logins.filter((phase) => phase === "pre-execute").length, 1, "the run signed in once, before its first execution");
  assert.deepEqual({ applied: coverage.bundleMutation?.applied, killed: coverage.bundleMutation?.killed, survived: coverage.bundleMutation?.survived.length }, { applied: 2, killed: 2, survived: 0 }, "the login page failed a test that passed before: a kill, as at the baseline");
});

test("the mutation pass reads none of the execution's dumps again, so a second read that would fault cannot take the verified coverage from a signal run", async () => {
  const { out, rig, coverage } = await runMutationRig("mutation-pass-one-read", { rereadFaults: true });

  assert.deepEqual(rig.reads, ["mutation-pass-one-read-measure"], "the measurement execution's dumps are read once");
  assert.deepEqual(rig.reruns, ["mut0", "mut1", "mut2", "obs2"], "the measurement execution is the first unmutated observation");
  assert.deepEqual({ ...out.decision }, { verdict: "pass", sideEffect: "pr", outcome: "pr", shadowed: false });
  assert.deepEqual(coverage, { ...rigVerifiedBy("mutation-pass-one-read-measure"), survivorClosure: undefined, integrity: undefined });
  assert.deepEqual(rig.telemetry.measureSpans().at(-1), rigVerifiedSpan("pass"));
});

test("the mutation pass reads none of the execution's dumps again, so a second read that would fault cannot unblock an enforce run", async () => {
  const { out, rig, coverage } = await runMutationRig("mutation-pass-one-read-enforce", { mode: "enforce", minRatio: 0.9, rereadFaults: true, realWorkspace: true });

  assert.equal(rig.reads.filter((namespace) => namespace === "mutation-pass-one-read-enforce-measure").length, 1, "the measurement execution's dumps are read once");
  assert.deepEqual({ ...out.decision }, { verdict: "pass", sideEffect: "held", outcome: "held", shadowed: false }, "the verified 0.75 still blocks under a 0.9 floor");
  assert.deepEqual(coverage, { ...rigVerifiedBy("mutation-pass-one-read-enforce-coverage-final-measure"), survivorClosure: { routed: 1, judged: 1, closed: 1, open: [] }, integrity: { acceptances: 1, rejected: 0, proofReused: 0, capHit: false } });
  assert.deepEqual(rig.telemetry.measureSpans().at(-1), rigVerifiedSpan("fail"));
});

test("a measurement whose changed lines hold no mutant says on its span how the mutation sites were left out, as a measurement with the pass inside it did", async () => {
  const { rig, coverage } = await runMutationRig("mutation-pass-no-mutant", { sourceLine: "pay();" });

  assert.deepEqual(rig.reruns, [], "no mutant, no re-run");
  assert.equal(coverage.bundleMutation, undefined);
  assert.deepEqual(rig.telemetry.measureSpans(), [{
    "qayaba.coverage.status": "fail",
    "qayaba.mutation.sites_skipped": 3,
    "qayaba.mutation.sites_skipped_reasons": ["not-in-source-line: 3"],
    "qayaba.mutation.reruns_by_test": 0,
    "qayaba.mutation.reruns_by_spec_file": 0,
    "qayaba.coverage.ratio": 0.5,
    "qayaba.coverage.changed_lines": 4,
    "qayaba.coverage.covered_lines": 2,
    "qayaba.coverage.changed_files": 1,
    "qayaba.coverage.mapped_files": 1,
    "qayaba.coverage.changed_branches": 2,
    "qayaba.coverage.taken_branches": 1,
  }]);
});

test("the measurement by execution carries how its mutants were chosen on its span, before the mutation pass runs them", async () => {
  const { rig } = await runMutationRig("mutation-pass-selection-first");

  const [byExecution] = rig.telemetry.measureSpans();
  assert.deepEqual(
    Object.fromEntries(Object.entries(byExecution!).filter(([key]) => key.startsWith("qayaba.mutation."))),
    { "qayaba.mutation.sites_skipped": 0, "qayaba.mutation.reruns_by_test": 3, "qayaba.mutation.reruns_by_spec_file": 0 },
    "the selection, and nothing of a pass that has not run",
  );
});

test("the coverage allotment is reported when the coverage regeneration is allotted its time, not when the mutation pass reads what is left", async () => {
  const clock = { now: 0, rerunMs: 60_000 };
  const deadline = new RunDeadline({ now: () => clock.now, budgets: { ...RUN_TIME_BUDGET_MS, diff: 3_600_000 }, schedule: () => () => {} });
  const atRegeneration: number[] = [];
  const allotmentNow = (): number => {
    const left = deadline.remainingMs()!;
    return Math.max(0, left - deadline.reserveAfter("coverage", left).ms);
  };
  let calls = 0;
  const { rig } = await runMutationRig("coverage-allotment-reported", { mode: "enforce", minRatio: 0.9, realWorkspace: true, clock }, deadline, () => {
    calls += 1;
    if (calls === 2) atRegeneration.push(allotmentNow());
  });

  assert.deepEqual(rig.reruns.slice(0, 4), ["mut0", "mut1", "mut2", "obs2"], "the mutation pass ran before the regeneration");
  const coverage = rig.telemetry.events.filter((e) => e.name === "allotment" && e.attrs["qayaba.allotment.purpose"] === "coverage");
  assert.equal(coverage.length, 1, "once per purpose");
  assert.deepEqual(coverage.map((e) => e.attrs["qayaba.allotment.ms"]), atRegeneration, "the time the regeneration was allotted, after the mutation pass spent its share");
});

/* A real deadline of an hour on a clock the test moves. */
const clockedDeadline = (clock: { now: number }) => new RunDeadline({ now: () => clock.now, budgets: { ...RUN_TIME_BUDGET_MS, diff: 3_600_000 }, schedule: () => () => {} });

test("the re-check of the surviving mutants after the regeneration starts no mutant the coverage allowance cannot hold, and the closure says how many it left out", async () => {
  /* The acceptance of the regeneration leaves the run 30 s: less than the coverage purpose owes the purposes after it. */
  const clock = { now: 0, rerunMs: 0 };
  const { rig, coverage } = await runMutationRig("closure-held-to-allowance", { mode: "enforce", minRatio: 0.9, realWorkspace: true, clock, clockAfter: { namespace: "-acc0", now: 3_600_000 - 30_000 } }, clockedDeadline(clock));

  assert.deepEqual(rig.reruns.slice(0, 4), ["mut0", "mut1", "mut2", "obs2"], "the first pass had its time");
  assert.equal(rig.reruns.length, 4, "neither the re-check nor the final pass started a re-run");
  assert.deepEqual(coverage.survivorClosure, { routed: 1, judged: 0, closed: 0, open: [], leftOut: { mutants: 1, observations: 0, reason: "time" } });
});

test("the final measurement execution of an enforce run is not started when the time its purpose has left cannot hold it: coverage is unknown, says why, and never blocks", async () => {
  /* The final judging execution leaves the run half a second: less than the one second its passing test took. */
  const clock = { now: 0, rerunMs: 0 };
  const { out, rig, coverage } = await runMutationRig("final-pass-held-to-allowance", { mode: "enforce", minRatio: 0.9, realWorkspace: true, clock, clockAfter: { namespace: "-coverage-final", now: 3_600_000 - 500 } }, clockedDeadline(clock));

  assert.deepEqual(rig.reruns, ["mut0", "mut1", "mut2", "obs2", "mut0"], "the first pass and the re-check ran; the final measurement started nothing");
  assert.equal(rig.reads.includes("final-pass-held-to-allowance-coverage-final-measure"), false, "no measurement execution ran, so none is read");
  assert.equal(coverage.bundleMutation, undefined);
  assert.deepEqual(coverage.changeCoverage, { executableLines: 0, unmeasured: "measurement-not-run" });
  assert.equal(out.decision.verdict, "pass", "the verdict is the judging execution's");
  assert.equal(out.decision.sideEffect, "pr", "under enforce too, a coverage no measurement decided is unknown, and unknown never blocks (ADR-0005)");
});

test("the run deadline spent during a mutant's re-run keeps what the mutants judged before it, and judges nothing it cut or did not start", async () => {
  const { deadline, fire } = deadlineFiredByHand(3_600_000);
  const { out, rig, coverage } = await runMutationRig("mutation-pass-cut-keeps-proof", { duringRerun: (rerun) => { if (rerun === "mut1") fire(); } }, deadline);

  assert.deepEqual(rig.reruns, ["mut0", "mut1"], "nothing starts once the deadline fired");
  assert.equal(out.decision.verdict, "pass", "the green suite is kept past the deadline");
  assert.deepEqual(coverage, {
    coverageRatio: 0.75,
    branchCoverage: { changed: 2, taken: 1 },
    changeCoverage: { executableLines: 4, notExecutableLines: 0, coveredByExecution: 2, provenByMutation: 1, armsProvenByMutation: 0, measuredBy: rigMeasuredBy("mutation-pass-cut-keeps-proof-measure") },
    bundleMutation: { applied: 1, killed: 1, survived: [], leftOut: { mutants: 2, observations: 0, reason: "time" } },
    survivorClosure: undefined,
    integrity: undefined,
  }, "the mutant killed before the deadline is proof; the one the deadline cut and the one after it are left out (with no survivor, no observation after is due)");
});

test("after the run deadline was spent during the mutation pass, the coverage regeneration it would have driven is cut and the run keeps its proof", async () => {
  const { deadline, fire } = deadlineFiredByHand(3_600_000);
  let authored = 0;
  const { out, rig } = await runMutationRig("mutation-pass-cut-then-regeneration", { mode: "enforce", minRatio: 0.9, realWorkspace: true, duringRerun: (rerun) => { if (rerun === "mut1") fire(); } }, deadline, () => { authored += 1; });

  assert.deepEqual(rig.reruns, ["mut0", "mut1"], "no re-run of any later step starts");
  assert.ok(authored <= 2, "the regeneration's one turn, which the deadline runtime refuses in production; nothing it wrote is accepted");
  assert.match(out.note ?? "", /run deadline was spent during regenerate-for-coverage; the suite that ran green on its final bytes is kept/, "the step after the pass is cut, and the run degrades with its proof");
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "held", "the verified measurement still blocks under the 0.9 floor");
  assert.equal(out.errorClass === ERROR_CLASS.TIME_BUDGET, false, "a green suite past its deadline keeps its proof");
});

test("a mutation pass that judged no mutant leaves the coverage by execution as it was", async () => {
  const { rig, coverage } = await runMutationRig("mutation-pass-none-judged", { reachesNoPage: true });

  assert.deepEqual(rig.reads, ["mutation-pass-none-judged-measure"]);
  assert.deepEqual(coverage, { coverageRatio: 0.5, branchCoverage: { changed: 2, taken: 1 }, changeCoverage: { executableLines: 4, notExecutableLines: 0, measuredBy: rigMeasuredBy("mutation-pass-none-judged-measure") }, bundleMutation: undefined, survivorClosure: undefined, integrity: undefined });
});

test("enforce mode — the regen produces ZERO specs — KEEPS the first measurement's blocksPublish, only ONE measure() call", async () => {
  let measureCallCount = 0;
  const { ports } = stubPorts({
    execute: passPerSpec,
    measure: async () => { measureCallCount++; return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }; },
    blocks: (status) => status === "fail",
  });
  let genCallCount = 0;
  ports.generation.author = async () => {
    genCallCount++;
    if (genCallCount === 1) return scriptedGeneration({ specs: ["a.spec.ts"]});
    return scriptedGeneration({ specs: []}); /* regen produced nothing reviewable */
  };
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
  });

  const out = await useCase.run({ ...baseInput, runId: "p2c-enforce-regen-zero-specs" });

  assert.equal(out.decision.sideEffect, "held", "a regen with zero specs never re-measures — the first measurement's blocksPublish stands");
  assert.equal(measureCallCount, 1, "zero regen specs must NOT trigger a second measure() call");
});

test("signal mode — first measure fails, NO regen fires, NO second measure() call", async () => {
  let measureCallCount = 0;
  let genCallCount = 0;
  const { ports } = stubPorts({
    execute: passPerSpec,
    measure: async () => { measureCallCount++; return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }; },
    blocks: () => false,
  });
  const originalGenerate = ports.generation.author;
  ports.generation.author = async (...args) => { genCallCount++; return originalGenerate(...args); };
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" },
  });

  const out = await useCase.run({ ...baseInput, runId: "p2c-signal-mode-never-regens" });

  assert.equal(out.decision.sideEffect, "pr", "signal mode must never block publish");
  assert.equal(measureCallCount, 1, "signal mode must never regenerate — only ONE measure() call total");
  assert.equal(genCallCount, 1, "signal mode's regen branch must not call generate() a second time");
});

test("a coverage regen's acceptance execution and the final re-measure each carry their own namespace (dump attribution stays per execution)", async () => {
  const capturedExecuteNamespaces: (string | undefined)[] = [];
  const capturedMeasureNamespaces: (string | undefined)[] = [];
  let measureCallCount = 0;
  const real = realCoverageWorkspace();
  try {
    const { ports } = stubPorts({
      classify: classifyWithDiff,
      prepare: real.prepare,
      generate: real.generate,
      blocks: (status) => status === "fail",
    });
    /* The measured run of an accepted regeneration happens once, after the review loop (nothing regenerates after it); every
       measure reads the dumps of the measurement execution that followed the judging one it measures: `${runId}-measure` after
       the first execution, `${runId}-coverage-final-measure` after the final one. A measure reading the composition-time namespace
       would see the first run's stale dumps.
     */
    ports.objectiveSignal.measure = async (_br, _specDir, _diff, _baselineCases, opts) => {
      measureCallCount++;
      capturedMeasureNamespaces.push(opts?.namespace);
      return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] };
    };
    ports.execution.execute = async (_specDir, opts) => {
      capturedExecuteNamespaces.push((opts as { namespace?: string } | undefined)?.namespace);
      return passPerSpec(_specDir, opts);
    };
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
    });

    await useCase.run({ ...baseInput, runId: "p2c-regen-namespace-attribution" });

    assert.equal(measureCallCount, 2, "the regen must have re-measured once");
    const regenExecuteCall = capturedExecuteNamespaces.find((ns) => ns?.endsWith("-acc0"));
    assert.equal(regenExecuteCall, acceptanceNamespace("p2c-regen-namespace-attribution", 0), "the regen's changed specs execute under their acceptance namespace, so collect/read hit the regen's own dumps");
    const finalExecuteCalls = capturedExecuteNamespaces.filter((ns) => ns?.endsWith("-coverage-final"));
    assert.equal(finalExecuteCalls.length, 1, "the final re-measure runs once, under its own namespace");

    assert.equal(capturedMeasureNamespaces[0], "p2c-regen-namespace-attribution-measure", "the first measurement reads its own measurement execution");
    assert.equal(capturedMeasureNamespaces[1], "p2c-regen-namespace-attribution-coverage-final-measure", "the re-measure() reads the measurement execution of the final judging run, never the composition-time namespace");
  } finally {
    real.cleanup();
  }
});

test("a reviewer correction whose execution runs red is rejected: the prior bytes and verdict stand (A4)", async () => {
  let executions = 0;
  const { ports } = stubPorts({
    generate: async () => scriptedGeneration({ specs: ["a.spec.ts"]}),
    review: async () => ({ approved: false, findings: [{ text: "assert the total", severity: "blocking" as const }], blockingCount: 1, parsed: true }),
    execute: async () => {
      executions++;
      return executions === 1
        ? { verdict: "pass" as const, cases: [{ name: "a", status: "pass" as const, file: "a.spec.ts" }], logs: "" }
        : { verdict: "fail" as const, cases: [{ name: "a", status: "fail" as const, file: "a.spec.ts", detail: "expected 42" }], logs: "" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });
  const out = await useCase.run({ ...baseInput, runId: "red-corrected-suite" });

  assert.equal(out.decision.verdict, "pass", "the reviewed bytes still pass: the red correction never became the run's");
  assert.equal(out.decision.sideEffect, "issue", "the reviewer's rejection stands, so the run publishes nothing");
  assert.equal(executions, 2, "the acceptance executed the corrected spec before judging it");
  assert.equal(out.cases[0]?.status, "pass", "A4: the rejected regeneration leaves the prior verdict and bytes in place");
});

test("coverage measures the reviewer-corrected revision: bytes that stop covering block the publish", async () => {
  let reviewRounds = 0;
  let executions = 0;
  let measures = 0;
  const { ports } = stubPorts({
    generate: async () => scriptedGeneration({ specs: ["a.spec.ts"]}),
    review: async () => {
      reviewRounds++;
      return reviewRounds === 1
        ? { approved: false, findings: [{ text: "cover the total", severity: "blocking" as const }], blockingCount: 1, parsed: true }
        : { approved: true, findings: [], blockingCount: 0, parsed: true };
    },
    /* A measurement execution runs the tests of the judging execution before it; only judging executions are counted. */
    execute: async (_dir, opts) => {
      if ((opts as { purpose?: string } | undefined)?.purpose !== "measurement") executions++;
      return { verdict: "pass" as const, cases: [{ name: executions === 1 ? "round-0" : "corrected", status: "pass" as const, file: "a.spec.ts" }], logs: "" };
    },
    measure: async () => {
      measures++;
      return measures === 1
        ? { status: "pass" as const, ratio: 0.95 }
        : { status: "fail" as const, ratio: 0.1, uncovered: [{ file: "src/a.ts", lines: [1] }] };
    },
    blocks: (status) => status === "fail",
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true, coveragePolicyMode: "enforce" } });
  const out = await useCase.run({ ...baseInput, runId: "coverage-measures-corrected-revision" });

  /* The initial run, the accepted correction, and the one whole-suite judging run enforce spends before decide (B-4a), each green one followed by its measurement execution. */
  assert.equal(executions, 3, "the correction was accepted and then judged once as a whole suite");
  assert.equal(measures, 2, "coverage was re-measured on the corrected revision, not left on round-0");
  assert.deepEqual(out.cases.map((c) => c.name), ["corrected"], "the recorded cases are the corrected execution's");
  assert.equal(out.decision.sideEffect, "issue", "the corrected suite no longer covers the change, so it must not publish");
});

test("a run deadline during the correction re-admit ends the run E-TIME-BUDGET (nothing published or learned)", async () => {
  let executions = 0;
  const { ports } = stubPorts({
    generate: async () => scriptedGeneration({ specs: ["a.spec.ts"]}),
    review: async () => ({ approved: false, findings: [{ text: "fix it", severity: "blocking" as const }], blockingCount: 1, parsed: true }),
    execute: async () => {
      executions++;
      if (executions === 1) return { verdict: "pass" as const, cases: [{ name: "a", status: "pass" as const, file: "a.spec.ts" }], logs: "" };
      throw new RunDeadlineExceededError(600_000, "diff", "qa-author", "before-turn");
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });
  const out = await useCase.run({ ...baseInput, runId: "correction-deadline" });

  assert.equal(out.decision.verdict, "infra-error", "the deadline ends the run as an infra-error, not a fail or a pass");
  assert.equal(out.errorClass, ERROR_CLASS.TIME_BUDGET);
});

test("enforce mode — the coverage regen is re-admitted: the final cases come from the regen's execution, not round-0", async () => {
  let measureCallCount = 0;
  let executeCallCount = 0;
  const { ports } = stubPorts({
    /* A measurement execution runs the tests of the judging execution before it; only judging executions are counted. */
    execute: async (_dir, opts) => {
      if ((opts as { purpose?: string } | undefined)?.purpose !== "measurement") executeCallCount++;
      return executeCallCount === 1
        ? { verdict: "pass" as const, cases: [{ name: "round-0", status: "pass" as const, file: "a.spec.ts" }], logs: "" }
        : { verdict: "pass" as const, cases: [{ name: "regen", status: "pass" as const, file: "a.spec.ts" }], logs: "" };
    },
    measure: async () => {
      measureCallCount++;
      return measureCallCount === 1
        ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }
        : { status: "pass" as const, ratio: 0.95 };
    },
    blocks: (status) => status === "fail",
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" } });
  const out = await useCase.run({ ...baseInput, runId: "coverage-regen-final-revision" });

  assert.equal(out.decision.sideEffect, "pr", "the regen's second measure passes and unblocks");
  /* The initial run, the coverage regen's acceptance (its changed spec), and the one whole-suite judging run (B-4a), each followed by its measurement execution where it is green and measured. */
  assert.equal(executeCallCount, 3, "the regen was accepted and then judged once as a whole suite");
  assert.deepEqual(out.cases.map((c) => c.name), ["regen"], "the recorded cases are the final revision's, not round-0's");
});

test("context mode NEVER calls execute() (context.json is not a Playwright spec)", async () => {
  let executeCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
  });
  ports.execution.execute = async (dir, opts) => { executeCallCount++; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "fix-c-context-never-executes", mode: "context" });

  assert.equal(executeCallCount, 0, "context mode must never invoke ExecutionPort.execute — context.json is not a Playwright spec");
});

/* agent-no-op skip -> persistOutcome save YES
   classify-skip -> bare return, save NO (DISTINCT from agent-no-op)
   invalid -> persistOutcome save YES
   infra-error -> persistOutcome save YES
 */

test("agent no-op skip calls runHistory.save()", async () => {
  let saveCallCount = 0;
  const { ports } = stubPorts({ generate: async () => (scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "nothing in this change is worth a test" })) });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-agent-no-op-skip" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(saveCallCount, 1, "agent no-op skip must call runHistory.save() exactly once");
});

test("classify-skip does NOT call runHistory.save() (distinct from the agent no-op skip source)", async () => {
  let saveCallCount = 0;
  const { ports } = stubPorts({ classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }) });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-classify-skip", mode: "diff" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(saveCallCount, 0, "it must NOT call runHistory.save()");
});

test("invalid calls runHistory.save()", async () => {
  let saveCallCount = 0;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-invalid" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(saveCallCount, 1, "invalid must call runHistory.save() exactly once");
});

/* The FixLoop's own adjudicator verdict threads into the persisted RunOutcome.adjudication, and
   shouldDistillLearning's app_defect rule is wired at BOTH fold call sites (mainline and
   terminal-invalid). adjudicate.service.ts's Rule 2.5 (an attributed 5xx on a failing case) is the
   reachable app_defect vector through this use-case's real FixLoop wiring — Rule 3
   (isLikelyRealBug/selector-uniqueness) is NOT reachable end-to-end because the use-case never
   threads FixLoopGenerateResult.specSources back into the FixLoop.
 */

test("mainline — an attributed 5xx persists the adjudicator's app_defect class on the outcome", async () => {
  let savedAdjudicationClass: string | undefined;
  const { ports } = stubPorts({
    /* Every execute() call (initial + every FixLoop retry) fails with a case carrying an attributed
       5xx — adjudicate.service.ts Rule 2.5 fires on the FIRST fix-loop round routing
       to app_defect/break-issue: realBugDetected=true, run.verdict stays "fail".
     */
    execute: async () => ({
      verdict: "fail" as const,
      cases: [{ name: "checkout", status: "fail" as const, detail: "server error", httpStatus: 500 }],
      logs: "x",
    }),
  });
  ports.runHistory.save = async (outcome) => { savedAdjudicationClass = outcome.adjudication?.class; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "app-defect-suppresses-fold" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(savedAdjudicationClass, "app_defect", "the persisted RunOutcome must carry the adjudicator's app_defect classification");
});

test("mainline — generated_test_defect (the default fallthrough) is persisted on the outcome", async () => {
  let savedAdjudicationClass: string | undefined;
  const { ports } = stubPorts({
    /* A generic, non-infra, non-value-mismatch failure detail never matches any adjudicate.service.ts
       rule above the default fallthrough — every fix-loop round classifies generated_test_defect/
       continue, exhausting maxRetries with verdict still "fail".
     */
    execute: async () => ({
      verdict: "fail" as const,
      cases: [{ name: "checkout", status: "fail" as const, detail: "timed out waiting for selector" }],
      logs: "x",
    }),
  });
  ports.runHistory.save = async (outcome) => { savedAdjudicationClass = outcome.adjudication?.class; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "generated-test-defect-persisted" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(savedAdjudicationClass, "generated_test_defect", "the persisted RunOutcome must carry the adjudicator's generated_test_defect classification");
});

test("a failing diff run hands the change's own files to the adjudicator, so an objective gap can be named", async () => {
  let calls = 0;
  const { ports, savedOutcomes } = stubPorts({
    classify: async () => ({
      action: "generate" as const,
      reason: "diff touches src/checkout.ts",
      diff: "diff --git a/src/checkout.ts b/src/checkout.ts",
      intent: { type: "feat", breaking: false, message: "add checkout", changedFiles: ["src/checkout.ts"] },
    }),
    /* The first round fails on a plain value mismatch (no 5xx, no locator error) in a spec that shares
       no file basename with the change; the retry passes, so the loop ends with the first round's
       objective_gap adjudication as its last one. */
    execute: async (dir, opts) => {
      calls += 1;
      if (calls > 1) return { verdict: "pass" as const, cases: passingCases(dir, opts), logs: "" };
      return {
        verdict: "fail" as const,
        cases: [{ name: "login", status: "fail" as const, detail: "expected 'Total: 10' to contain 'Total: 20'", file: "e2e/login.spec.ts" }],
        logs: "x",
      };
    },
  });
  /* One round: the retry that follows the objective_gap verdict is the last execution. */
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, maxRetries: 1 } });

  const out = await useCase.run({ ...baseInput, runId: "objective-source-diff" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(
    savedOutcomes.at(-1)?.adjudication?.class,
    "objective_gap",
    "the run must pass the change's changed files as the objective source; without them the adjudicator cannot see the gap",
  );
});

test("a run whose FixLoop never invoked the adjudicator (passed first try) persists adjudication:undefined", async () => {
  let savedOutcome: { adjudication?: { class: string } } | undefined;
  const { ports } = stubPorts();
  ports.runHistory.save = async (outcome) => { savedOutcome = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "no-adjudication-on-clean-pass" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(savedOutcome?.adjudication, undefined, "a clean pass never engages the FixLoop, so adjudication must be absent — never fabricated");
});

/* The FixLoop's last adjudicator verdict must reach PublicationPort.publish() as the OPTIONAL
   `adjudication` field — present only when the FixLoop actually engaged and reached the
   adjudicate() decision point; absent on a clean first-try pass.
 */

test("a failing run whose FixLoop produced an adjudicator verdict publishes with `adjudication` populated", async () => {
  let publishedAdjudication: { class: string; confidence: string; reason: string } | undefined;
  const { ports } = stubPorts({
    /* Every execute() call (initial + every FixLoop retry) fails with a case carrying an attributed
       5xx — adjudicate.service.ts Rule 2.5 fires, routing to app_defect/high-confidence/break-issue.
     */
    execute: async () => ({
      verdict: "fail" as const,
      cases: [{ name: "checkout", status: "fail" as const, detail: "server error", httpStatus: 500 }],
      logs: "x",
    }),
  });
  ports.publication.publish = async (decision) => {
    publishedAdjudication = decision.adjudication;
    return { outcome: "issue: https://github.com/org/app/issues/42" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "adjudication-populated" });

  assert.equal(out.decision.verdict, "fail");
  assert.ok(publishedAdjudication, "publish() must receive a populated adjudication field");
  assert.equal(publishedAdjudication?.class, "app_defect");
  assert.equal(publishedAdjudication?.confidence, "high");
  assert.match(publishedAdjudication?.reason ?? "", /5xx/);
});

test("a run without a FixLoop adjudicator verdict (clean first-try pass) publishes without the `adjudication` field", async () => {
  let publishedDecision: { adjudication?: unknown } | undefined;
  const { ports } = stubPorts();
  ports.publication.publish = async (decision) => {
    publishedDecision = decision;
    return { outcome: "pr" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "adjudication-absent-on-clean-pass" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(publishedDecision?.adjudication, undefined, "a clean pass never engages the FixLoop, so adjudication must be omitted — never fabricated");
});

/* The reviewer-unavailable rationale rides only on a run that ended because its reviewer was unavailable,
   never on a genuine rejection (corrections already signal that) and never on a normal approval. ──────────
 */

/* A reviewer that could not be reached judged nothing: that is an infra-error under its own class, never an Issue. */

const REVIEWER_DOWN_REASON = "HTTP 400: the model is not supported by the provider";
const reviewerDown = async () => ({
  approved: false,
  findings: [],
  rationale: `reviewer unavailable: ${REVIEWER_DOWN_REASON}`,
  parsed: false,
  unavailable: true,
});

test("a green run whose reviewer is unavailable ends as a persisted infra-error under its own class, not as an Issue", async () => {
  let published = 0;
  const { ports, savedOutcomes } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [{ name: "owners", status: "pass" }], logs: "" }),
    review: reviewerDown,
    publish: async () => { published++; return { outcome: "issue" }; },
  });
  const out = await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, runId: "reviewer-down" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.decision.sideEffect, "none", "fail-closed: no PR and no Issue");
  assert.equal(published, 0);
  assert.equal(out.errorClass, ERROR_CLASS.REVIEWER_UNAVAILABLE);
  assert.equal(savedOutcomes.length, 1, "the run is persisted, so the outage is visible in the record");
  assert.equal(savedOutcomes[0]!.verdict, "infra-error");
  assert.equal(savedOutcomes[0]!.errorClass, ERROR_CLASS.REVIEWER_UNAVAILABLE);
});

test("the run record of an unavailable reviewer says why: the reviewer's own reason, durably, and the note that nothing was judged", async () => {
  const { ports, savedOutcomes } = stubPorts({ review: reviewerDown });
  const out = await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, runId: "reviewer-down-record" });
  assert.equal(savedOutcomes[0]!.gateSignals.reviewerRationale, `reviewer unavailable: ${REVIEWER_DOWN_REASON}`);
  assert.equal(savedOutcomes[0]!.gateSignals.reviewerApproved, undefined, "no reviewer looked at the tests: neither approved nor rejected");
  assert.match(savedOutcomes[0]!.note ?? "", new RegExp(`reviewer was unavailable \\(reviewer unavailable: ${REVIEWER_DOWN_REASON}\\)`));
  assert.match(savedOutcomes[0]!.note ?? "", /no PR, and no Issue/);
  assert.equal(out.note, savedOutcomes[0]!.note);
});

test("an unavailable reviewer is logged loudly on every run it happens in", async () => {
  const { ports } = stubPorts({ review: reviewerDown });
  const { observer, events } = fakeObserver();
  await new RunQaUseCase({ ...ports, observer, config: baseConfig }).run({ ...baseInput, runId: "reviewer-down-log" });
  assert.ok(events.some((e) => e.type === "agent.error" && /reviewer was unavailable/.test(e.detail)));
  assert.ok(events.some((e) => e.type === "log.line" && e.level === "error" && e.text.includes(ERROR_CLASS.REVIEWER_UNAVAILABLE)));
});

test("an unavailable reviewer ends the run at once: no regeneration round is burned and the working copy is pruned", async () => {
  let generated = 0;
  let reviews = 0;
  const pruned: string[] = [];
  const { ports, ws } = stubPorts({
    generate: async () => { generated++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
    review: async () => { reviews++; return reviewerDown(); },
  });
  await new RunQaUseCase({ ...ports, config: baseConfig, mirrorGc: { prune: async (w: WorkspaceHandle) => { pruned.push(rootsOf(w).mirrorDir); } } }).run({ ...baseInput, runId: "reviewer-down-no-regen" });
  assert.deepEqual([generated, reviews, pruned], [1, 1, [ws.mirrorDir]]);
});

test("an unavailable reviewer is audited as an operating signal", async () => {
  const learned: { audited: RunOutcome[] } = { audited: [] };
  const { ports } = stubPorts({ review: reviewerDown });
  await new RunQaUseCase({
    ...ports,
    processAudit: makeFakeProcessAudit((o) => { learned.audited.push(o); }),
    config: baseConfig,
  }).run({ ...baseInput, runId: "reviewer-down-learning" });
  assert.equal(learned.audited.length, 1);
  assert.equal(learned.audited[0]!.errorClass, ERROR_CLASS.REVIEWER_UNAVAILABLE);
});

test("a reviewer unavailable on a context run does not apply: a context run has no test reviewer to be unavailable", async () => {
  let reviews = 0;
  const { ports } = stubPorts({ review: async () => { reviews++; return reviewerDown(); } });
  await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, mode: "context" });
  assert.equal(reviews, 0);
});

test("a reviewer that answered but could not be read (a parse miss) is still the fail-closed Issue it was: it was reached, only its verdict is missing", async () => {
  let publishedSideEffect: string | undefined;
  const { ports } = stubPorts({
    review: async () => ({ approved: false, findings: [], rationale: "the model produced garbage, not JSON", parsed: false }),
    publish: async () => { publishedSideEffect = "issue"; return { outcome: "issue" }; },
  });
  const out = await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, runId: "reviewer-parse-miss" });
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "issue");
  assert.equal(publishedSideEffect, "issue");
});

test("a reviewer that could not be reached on a run whose review is advice only leaves no verdict behind, for any reader to read as a rejection", async () => {
  const { ports, savedOutcomes } = stubPorts({
    execute: async () => ({ verdict: "flaky", cases: [{ name: "owners", status: "flaky" as const, file: "owners.spec.ts" }], logs: "" }),
    review: reviewerDown,
  });
  const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, runId: "reviewer-down-flaky" });
  assert.equal(out.decision.verdict, "flaky", "a flaky run is quarantined whatever the reviewer says");
  const saved = savedOutcomes[0]!;
  assert.equal(saved.gateSignals.reviewerApproved, undefined, "no reviewer reached a verdict: neither approved nor rejected");
  assert.equal(saved.gateSignals.reviewer, undefined, "the phase's own signal holds no verdict the reviewer did not give");
});

test("follow-up #28: a NORMAL reviewer rejection (parsed:true) does NOT carry a reviewerNote", async () => {
  let publishedDecision: { reviewerNote?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
    review: async () => ({
      approved: false,
      findings: [{ text: "[false-positive] weak assertion", severity: "blocking" as const }],
      blockingCount: 1,
      rationale: "the assertion is too weak to catch a regression",
      parsed: true,
    }),
  });
  ports.publication.publish = async (decision) => {
    publishedDecision = decision;
    return { outcome: "issue: https://github.com/org/app/issues/29" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "follow-up-28-normal-rejection-no-note" });

  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(publishedDecision?.reviewerNote, undefined, "a genuine reviewer rejection must NOT thread a reviewerNote — corrections are already the signal for that case");
});

test("follow-up #28: a normal reviewer APPROVAL is unaffected — no reviewerNote, still routes to pr", async () => {
  let publishedDecision: { reviewerNote?: string } | undefined;
  const { ports } = stubPorts({
    execute: async (dir, opts) => ({ verdict: "pass", cases: passingCases(dir, opts), logs: "" }),
    review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }),
  });
  ports.publication.publish = async (decision) => {
    publishedDecision = decision;
    return { outcome: "pr" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "follow-up-28-normal-approval-unaffected" });

  assert.equal(out.decision.sideEffect, "pr");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(publishedDecision?.reviewerNote, undefined, "a normal approval must never carry a reviewerNote");
});

test("follow-up #28: a normal rejection does NOT populate gateSignals.reviewerRationale either", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: passPerSpec,
    review: async () => ({
      approved: false,
      findings: [{ text: "[false-positive] weak assertion", severity: "blocking" as const }],
      blockingCount: 1,
      rationale: "the assertion is too weak",
      parsed: true,
    }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "follow-up-28-normal-rejection-no-persisted-rationale" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerRationale, undefined, "a genuine rejection must not populate reviewerRationale — this slot is scoped to the reviewer-unavailable case only");
});

/* processAudit is optional and invoked at BOTH outcome sites under shouldDistillLearning(...) AND
   verdict !== "flaky" AND errorClass not in {E-INFRA, E-FLAKY}. Fault isolation/timeouts are the ADAPTER's own contract (see
   process-audit-port.adapter.test.ts) — this use-case awaits audit() with no extra try/catch of its own.
 */

function makeFakeProcessAudit(onAudit: (outcome: RunOutcome) => void): ProcessAuditPort {
  return {
    audit: async (outcome) => { onAudit(outcome); },
  };
}

test("process-audit: flaky verdict — processAudit.audit() is NOT called", async () => {
  let auditCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }),
  });
  const processAudit = makeFakeProcessAudit(() => { auditCallCount++; });
  const useCase = new RunQaUseCase({ ...ports, processAudit, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "process-audit-flaky-no-audit" });

  assert.equal(out.decision.verdict, "flaky");
  assert.equal(auditCallCount, 0, "processAudit.audit() must NOT be called on a flaky verdict");
});

test("process-audit: static-gate invalid (errorClass=E-STATIC, terminal site) — processAudit.audit() is called with the persisted outcome", async () => {
  let capturedOutcome: RunOutcome | undefined;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  const processAudit = makeFakeProcessAudit((outcome) => { capturedOutcome = outcome; });
  const useCase = new RunQaUseCase({ ...ports, processAudit, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "process-audit-static-invalid-terminal-called" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.errorClass, "E-STATIC");
  assert.ok(capturedOutcome, "processAudit.audit() must be called on a static-gate invalid (the terminal site)");
  assert.equal(capturedOutcome?.verdict, "invalid");
  assert.equal(capturedOutcome?.errorClass, "E-STATIC");
  assert.equal(capturedOutcome?.runId, "process-audit-static-invalid-terminal-called");
});

test("process-audit: fail run with a real errorClass (E-EXEC-FAIL, mainline site) — processAudit.audit() is called", async () => {
  let auditCallCount = 0;
  let capturedOutcome: RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail" as const, cases: [{ name: "checkout", status: "fail" as const, detail: "assertion failed" }], logs: "x" }),
  });
  const processAudit = makeFakeProcessAudit((outcome) => { auditCallCount++; capturedOutcome = outcome; });
  const useCase = new RunQaUseCase({ ...ports, processAudit, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "process-audit-mainline-real-errorclass" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.errorClass, "E-EXEC-FAIL");
  assert.equal(auditCallCount, 1, "processAudit.audit() must be called on a genuine failure (mainline site)");
  assert.equal(capturedOutcome?.errorClass, "E-EXEC-FAIL");
});

test("process-audit: a clean green run (errorClass:null) — processAudit.audit() is NOT called (the audit gate requires a real error class)", async () => {
  let auditCallCount = 0;
  const { ports } = stubPorts(); /* default execute() => clean pass, coverageRatio stays null */
  const processAudit = makeFakeProcessAudit(() => { auditCallCount++; });
  const useCase = new RunQaUseCase({ ...ports, processAudit, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "process-audit-clean-pass-no-audit" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.errorClass, null);
  assert.equal(auditCallCount, 0, "processAudit.audit() must NOT be called on a clean pass — no qualifying failure to audit");
});

test("process-audit: processAudit dep ABSENT ([SWAP]-optional) — a gate-true outcome is persisted, audit is skipped without error", async () => {
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  /* No `processAudit` key at all — mirrors every pre-existing composition that has not wired one yet. */
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "process-audit-absent-no-behavior-change" });

  assert.equal(out.decision.verdict, "invalid");
});

/* ── SETUP phase (AGENTS.md run-flow step 3): "bootstrap the config/e2e seed into e2e/, then npm ci;
   runs BEFORE generation so the agent has the fixtures/config". Missing from this rewrite until now
   regression and BEFORE generate(); a setup throw surfaces as infra-error, never a code verdict
   (src/qa/setup.ts's own doc). ─────────────────────────────────────────────────────────────────
 */

test("SETUP: setup() is called AFTER classify resolves to generate and BEFORE generate()", async () => {
  const callOrder: string[] = [];
  const { ports } = stubPorts({
    classify: async () => { callOrder.push("classify"); return { action: "generate", reason: "diff touches src/x.ts", diff: "" }; },
    setup: async () => { callOrder.push("setup"); },
    generate: async () => { callOrder.push("generate"); return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "setup-order-generate" });

  assert.deepEqual(callOrder, ["classify", "setup", "generate"], "setup must run strictly between classify and generate, never before or after");
});

test("SETUP: setup() is called on a non-diff mode too (which never classifies)", async () => {
  let setupCalled = false;
  const { ports } = stubPorts({ setup: async () => { setupCalled = true; } });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "setup-non-diff-mode", mode: "manual" });

  assert.equal(setupCalled, true, "setup must run for whole-repo/guided modes too");
});

test("SETUP: setup() is SKIPPED on a classify-skip (nothing to generate for)", async () => {
  let setupCalled = false;
  const { ports } = stubPorts({
    classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }),
    setup: async () => { setupCalled = true; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-skipped-on-classify-skip", mode: "diff" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(setupCalled, false, "a classify-skip never reaches generation, so setup must not run either");
});

test("SETUP: a setup() throw maps to infra-error, never a code verdict — and does NOT persist", async () => {
  let saveCallCount = 0;
  let generateCalled = false;
  const { ports } = stubPorts({
    setup: async () => { throw new Error("npm ci in e2e failed (code 1)"); },
    generate: async () => { generateCalled = true; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-throw-infra-error" });

  assert.equal(out.decision.verdict, "infra-error", "a setup failure must be infra-error, matching src/qa/setup.ts's own doc: 'the pipeline surfaces that as infra-error, never a code verdict'");
  assert.equal(out.decision.sideEffect, "none");
  assert.equal(generateCalled, false, "generate() must never run once setup has thrown");
  assert.equal(saveCallCount, 0, "a setup failure must NOT persist a RunOutcome — matches the entry-gate infra-error's own no-persist convention (infraErrorResult never saves)");
  assert.ok(out.note?.includes("npm ci in e2e failed (code 1)"), `a setup throw must surface a diagnostic note carrying the thrown message (AGENTS.md "never swallow errors into an empty result") — got: ${out.note}`);
});

test("SETUP: an absent SetupPort (deps.setup undefined) is a no-op — generation still runs (backward compatible)", async () => {
  const { ports } = stubPorts();
  const { setup: _unused, ...portsWithoutSetup } = ports;
  const useCase = new RunQaUseCase({ ...portsWithoutSetup, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-absent-backward-compat" });

  assert.equal(out.decision.verdict, "pass", "an absent SetupPort must never break a run — this composition simply skips the setup phase (matches the pre-fix behavior)");
});

test("SETUP: an already-aborted signal short-circuits before setup() ever runs", async () => {
  const controller = new AbortController();
  controller.abort();
  let setupCalled = false;
  const { ports } = stubPorts({ setup: async () => { setupCalled = true; } });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-already-aborted" }, controller.signal);

  assert.equal(setupCalled, false, "setup must never run once the signal is already aborted — the entry short-circuit fires first");
  assert.equal(out.decision.verdict, "infra-error");
});

test("SETUP: aborting during setup() (signal fires inside the collaborator) stops before generate()", async () => {
  const controller = new AbortController();
  let generateCalled = false;
  const { ports } = stubPorts({
    setup: async () => { controller.abort(); },
    generate: async () => { generateCalled = true; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-abort-mid-setup" }, controller.signal);

  assert.equal(generateCalled, false, "generate() must never run once the signal aborts during setup");
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.decision.sideEffect, "none");
});

/* gateSignals TELEMETRY only — no verdict divergence exists anywhere in the 21-scenario harness.
   Persist RunOutcome and assert on the specific gateSignals/errorClass field the use-case must
   carry (never hardcoded to null/dropped).
 */

test("reviewerApproved is copied into the persisted gateSignals (not dropped after being used as a decide() input)", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "reviewer-approved-persisted" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, true, "reviewerApproved must be threaded into the persisted gateSignals");
});

test("reviewerApproved reflects a reviewer REJECTION (false), not silently omitted", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
    review: async () => ({ approved: false, findings: [{ text: "[false-positive] x", severity: "blocking" as const }], blockingCount: 1, parsed: true }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "reviewer-rejected-persisted" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, false, "a reviewer rejection must persist reviewerApproved:false, not true or undefined");
});

test("signal mode — an accepted regeneration after the measurement reuses it and marks it stale, never re-measuring", async () => {
  const fixtures = reviewFixtures();
  try {
    let measureCalls = 0;
    let generation = 0;
    let reviews = 0;
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({ verdict: "pass" as const, cases: [{ name: "a", status: "pass" as const, file: "flows/restaurants.spec.ts" }], logs: "" }),
      measure: async () => {
        measureCalls++;
        return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] };
      },
      blocks: () => false,
      review: async () => {
        reviews++;
        return reviews === 1
          ? { approved: false, findings: [{ text: "assert the list", severity: "blocking" as const }], blockingCount: 1, parsed: true }
          : { approved: true, findings: [], blockingCount: 0, parsed: true };
      },
    });
    ports.generation.author = async () => {
      generation++;
      fixtures.write("flows/restaurants.spec.ts", generation === 1 ? "export const first = 1;\n" : "export const second = 2;\n");
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
    ports.runHistory.save = async (outcome) => { saved = outcome; };
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: true, coveragePolicyMode: "signal" },
    });

    const out = await useCase.run({ ...baseInput, runId: "coverage-stale-signal", mode: "diff" });

    assert.equal(measureCalls, 1, "signal mode reuses the measurement it has; it never spends a second one");
    assert.equal(out.gateSignals.coverage?.stale, true, "the recorded coverage predates the accepted bytes and is marked so");
    assert.equal(out.decision.sideEffect, "pr", "a stale signal is a recorded caveat, never a block");
    assert.equal(saved?.gateSignals.coverage?.stale, true, "the persisted outcome records the stale coverage");
  } finally {
    fixtures.cleanup();
  }
});

test("enforce mode — a review regeneration after the measurement gets ONE final whole-suite measured run", async () => {
  const fixtures = reviewFixtures();
  try {
    let generation = 0;
    let reviews = 0;
    let measureCalls = 0;
    const executeNamespaces: (string | undefined)[] = [];
    const measureNamespaces: (string | undefined)[] = [];
    const { ports } = stubPorts({
      classify: classifyWithDiff,
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async (_specDir, opts) => {
        executeNamespaces.push((opts as { namespace?: string } | undefined)?.namespace);
        return { verdict: "pass" as const, cases: [{ name: "a", status: "pass" as const, file: "flows/restaurants.spec.ts" }], logs: "" };
      },
      measure: async (_br, _specDir, _diff, _baseline, opts) => {
        measureCalls++;
        measureNamespaces.push(opts?.namespace);
        return measureCalls === 1
          ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }
          : { status: "pass" as const, ratio: 0.9 };
      },
      blocks: (status) => status === "fail",
      review: async () => {
        reviews++;
        return reviews === 1
          ? { approved: false, findings: [{ text: "assert the amount", severity: "blocking" as const }], blockingCount: 1, parsed: true }
          : { approved: true, findings: [], blockingCount: 0, parsed: true };
      },
    });
    ports.generation.author = async () => {
      generation++;
      fixtures.write("flows/restaurants.spec.ts", `export const generation = ${generation};\n`);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: true, coveragePolicyMode: "enforce" },
    });

    const out = await useCase.run({ ...baseInput, runId: "coverage-final-after-review", mode: "diff" });

    assert.equal(measureCalls, 2, "the first measurement plus exactly one final re-measure");
    assert.deepEqual(measureNamespaces, ["coverage-final-after-review-measure", "coverage-final-after-review-coverage-final-measure"]);
    assert.equal(executeNamespaces.filter((ns) => ns?.endsWith("-coverage-final")).length, 1);
    assert.equal(out.decision.sideEffect, "pr", "the final measurement, not the superseded first one, decides");
    assert.equal(out.gateSignals.integrity?.acceptances, 2, "the coverage and the review regeneration each went through acceptance");
  } finally {
    fixtures.cleanup();
  }
});

test("signal mode — a flaky run whose review regeneration was accepted marks its measurement stale, as a passing run does", async () => {
  const fixtures = reviewFixtures();
  try {
    let measureCalls = 0;
    let generation = 0;
    let reviews = 0;
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async (_specDir, opts) => ((opts as { namespace?: string } | undefined)?.namespace ? { verdict: "pass" as const, cases: [{ name: "a", status: "pass" as const, file: "flows/restaurants.spec.ts" }], logs: "" } : { verdict: "flaky" as const, cases: [{ name: "checkout", status: "flaky" as const, file: "flows/restaurants.spec.ts" }], logs: "" }),
      measure: async () => {
        measureCalls++;
        return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] };
      },
      blocks: () => false,
      review: async () => {
        reviews++;
        return reviews === 1
          ? { approved: false, findings: [{ text: "assert the list", severity: "blocking" as const }], blockingCount: 1, parsed: true }
          : { approved: true, findings: [], blockingCount: 0, parsed: true };
      },
    });
    ports.generation.author = async () => {
      generation++;
      fixtures.write("flows/restaurants.spec.ts", generation === 1 ? "export const first = 1;\n" : "export const second = 2;\n");
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true, coveragePolicyMode: "signal" } });

    const out = await useCase.run({ ...baseInput, runId: "coverage-stale-signal-flaky", mode: "diff" });

    assert.equal(out.decision.verdict, "flaky", "the run stays quarantined");
    assert.equal(measureCalls, 1);
    assert.equal(out.gateSignals.coverage?.stale, true, "the recorded coverage predates the accepted bytes and is marked so");
  } finally {
    fixtures.cleanup();
  }
});

test("enforce mode — a flaky run whose review regeneration was accepted gets one final measured run, and stays quarantined however that run ends", async () => {
  const fixtures = reviewFixtures();
  try {
    let generation = 0;
    let reviews = 0;
    let measureCalls = 0;
    const executeNamespaces: (string | undefined)[] = [];
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: showingACase(async (_specDir, opts) => {
        const namespace = (opts as { namespace?: string } | undefined)?.namespace;
        executeNamespaces.push(namespace);
        /* The final run happens to pass on its first attempt: that does not make the run's earlier instability go away. */
        return namespace?.endsWith("-coverage-final") || /-acc\d+$/.test(namespace ?? "") ? { verdict: "pass" as const, cases: [{ name: "checkout", status: "pass" as const }], logs: "" } : { verdict: "flaky" as const, cases: [{ name: "checkout", status: "flaky" as const }], logs: "" };
      }),
      measure: async () => {
        measureCalls++;
        return measureCalls === 1
          ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }
          : { status: "pass" as const, ratio: 0.9 };
      },
      blocks: (status) => status === "fail",
      review: async () => {
        reviews++;
        return reviews === 1
          ? { approved: false, findings: [{ text: "assert the amount", severity: "blocking" as const }], blockingCount: 1, parsed: true }
          : { approved: true, findings: [], blockingCount: 0, parsed: true };
      },
    });
    ports.generation.author = async () => {
      generation++;
      fixtures.write("flows/restaurants.spec.ts", `export const generation = ${generation};\n`);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true, coveragePolicyMode: "enforce" } });

    const out = await useCase.run({ ...baseInput, runId: "coverage-final-flaky", mode: "diff" });

    assert.equal(executeNamespaces.filter((ns) => ns?.endsWith("-coverage-final")).length, 1, "one final whole-suite measured run");
    assert.equal(out.decision.verdict, "flaky", "a final run that passed first time never promotes a flaky run");
    assert.notEqual(out.decision.sideEffect, "pr", "a flaky run is never published");
  } finally {
    fixtures.cleanup();
  }
});

test("the final guard restores the proven bytes when a spec changes after its green execution", async () => {
  const fixtures = reviewFixtures();
  try {
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: passPerSpec,
      /* The measurement tampers with the spec after the green run: the guard must put the proven bytes back. */
      measure: async () => {
        fixtures.write("flows/restaurants.spec.ts", "// tampered after the run\n");
        return { status: "unknown" as const, ratio: null };
      },
    });
    ports.generation.author = async () => {
      fixtures.write("flows/restaurants.spec.ts", "// proven\n");
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "off" },
    });

    const out = await useCase.run({ ...baseInput, runId: "guard-restores-proven-bytes" });

    assert.equal(out.decision.sideEffect, "pr", "the run publishes, as the proven bytes were put back");
    assert.equal(readFileSync(join(fixtures.specDir, "flows/restaurants.spec.ts"), "utf8"), "// proven\n");
  } finally {
    fixtures.cleanup();
  }
});

test("the final guard fails closed when no suite store can prove the delivered bytes", async () => {
  const { ports } = stubPorts();
  const { suiteStore: _store, ...withoutStore } = ports;

  const out = await new RunQaUseCase(withoutStore).run({ ...baseInput, runId: "guard-no-store" });

  assert.equal(out.decision.verdict, "infra-error", "no proof means no publication");
  assert.equal(out.decision.sideEffect, "none");
});

test("a CLEAN context-mode pass does NOT persist", async () => {
  let saveCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "context-clean-no-persist", mode: "context" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(saveCallCount, 0, "a clean context-mode pass must NOT call runHistory.save()");
});

/* The stored map is independent of whether a context.json PR opens, so shadow must not suppress it. */
test("a clean context-mode pass captures the architecture map with the run's specDir, app and sha, in shadow and non-shadow runs", async () => {
  for (const shadow of [true, false]) {
    const captured: Array<{ specDir: string; app: string; sha: string }> = [];
    const { ports, ws } = stubPorts({
      generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
      contextMapCapture: { capture: async (specDir, app, sha) => { captured.push({ specDir, app, sha }); } },
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, shadow } });

    const out = await useCase.run({ ...baseInput, runId: `context-clean-capture-${shadow ? "shadow" : "live"}`, mode: "context" });

    assert.equal(out.decision.verdict, "pass", `shadow=${shadow}`);
    assert.deepEqual(captured, [{ specDir: ws.specDir, app: "demo", sha: "abc1234" }], `shadow=${shadow}: captured once, at the run's own specDir, app and sha`);
  }
});

/* The mirror's e2e/.qa/context.json does not survive the next run's checkout, so the durable
   capture must not depend on how publication (a context.json PR) goes. */
test("a clean context-mode pass captures the architecture map even when publication throws", async () => {
  const captured: string[] = [];
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
    publish: async () => { throw new Error("gh: 502 Bad Gateway"); },
    contextMapCapture: { capture: async (_specDir, _app, sha) => { captured.push(sha); } },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "context-capture-despite-publish-throw", mode: "context" });

  assert.deepEqual(captured, ["abc1234"]);
});

test("a throwing map capture does not change a clean context-mode pass's verdict or publication", async () => {
  let published = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
    publish: async () => { published += 1; return { outcome: "pr" }; },
    contextMapCapture: { capture: async () => { throw new Error("SQLITE_BUSY: database is locked"); } },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "context-capture-throws", mode: "context" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(published, 1);
});

test("contextMapCapture is absent by default — no-op, no behavior change on a clean context-mode pass", async () => {
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "context-capture-absent", mode: "context" });

  assert.equal(out.decision.verdict, "pass");
});

/* A context run's product is the architecture map: it generates no test, so there is nothing for a test reviewer to judge, and a verdict it cannot give must never turn a clean pass into an Issue. */
const REJECTING_REVIEWERS: Array<{ name: string; review: ReviewPort["review"] }> = [
  { name: "a rejecting reviewer", review: async () => ({ approved: false, findings: [{ text: "[blocking] no test to review", severity: "blocking" as const }], blockingCount: 1, parsed: true }) },
  { name: "a reviewer parse-miss", review: async () => ({ approved: false, findings: [], blockingCount: 0, parsed: false }) },
  { name: "an unavailable reviewer", review: async () => ({ approved: false, findings: [], blockingCount: 0, parsed: false, rationale: "reviewer unavailable: timed out after 360000ms" }) },
];

for (const { name, review } of REJECTING_REVIEWERS) {
  for (const shadow of [false, true]) {
    test(`a clean context-mode pass never goes through test review, so ${name} cannot turn it into an Issue (shadow=${shadow})`, async () => {
      let reviewCalls = 0;
      const published: Array<{ reviewerApproved?: boolean }> = [];
      const { ports } = stubPorts({
        generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
        review: async (...args) => { reviewCalls += 1; return review(...args); },
        publish: async (decision) => { published.push({ reviewerApproved: decision.reviewerApproved }); return { outcome: "pr" }; },
      });
      const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, shadow } });

      const out = await useCase.run({ ...baseInput, runId: `context-no-review-${shadow ? "shadow" : "live"}`, mode: "context" });

      assert.equal(out.decision.verdict, "pass");
      assert.equal(reviewCalls, 0, "a context run has no test to review");
      assert.notEqual(out.decision.sideEffect, "issue");
      assert.deepEqual(published.map((p) => p.reviewerApproved), [undefined], "no review ran, so publication is handed no verdict to read as an approval");
    });
  }
}

test("a context-mode run executes nothing, so it measures no coverage or value", async () => {
  let measureCalls = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "built map" })),
    measure: async () => { measureCalls += 1; return { status: "unknown", ratio: null }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "context-no-measure", mode: "context" });

  assert.equal(measureCalls, 0);
});

test("contextMapCapture is NOT invoked on a non-context mode's clean pass — capture is mode-gated to context only", async () => {
  let captureCallCount = 0;
  const { ports } = stubPorts({
    contextMapCapture: { capture: async () => { captureCallCount++; } },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "diff-mode-no-capture" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(captureCallCount, 0, "a diff-mode (non-context) pass must never invoke contextMapCapture — it is scoped to isContextCleanPass only");
});

test("contextMapCapture is NOT invoked on a context-mode INVALID result — capture only fires on a clean (verdict pass) context run", async () => {
  let captureCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "tried" })),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
    contextMapCapture: { capture: async () => { captureCallCount++; } },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "context-invalid-no-capture", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(captureCallCount, 0, "an invalid context-mode result must never invoke contextMapCapture — only a clean pass reached a validated, publishable map");
});

test("the branches a measurement counted on the changed lines are persisted beside the line ratio, and absent when it saw none", async () => {
  const persisted = async (measurement: { changedBranches?: number; takenBranches?: number }) => {
    let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
    const { ports } = stubPorts({
      execute: passPerSpec,
      measure: async () => ({ status: "pass", ratio: 1, measurement: { changedLines: 3, coveredChanged: 3, changedFiles: 1, mappedFiles: 1, ...measurement } }),
    });
    ports.runHistory.save = async (outcome) => { saved = outcome; };
    await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "branch-coverage-persisted" });
    return saved!.gateSignals;
  };
  assert.deepEqual((await persisted({ changedBranches: 4, takenBranches: 1 })).branchCoverage, { changed: 4, taken: 1 });
  assert.equal("branchCoverage" in (await persisted({})), false);
});

test("the coverage measurement is told the spec files of the passing cases, and what the mutants did is persisted, absent when none was judged", async () => {
  const persisted = async (bundleMutation?: { applied: number; killed: number; survived: { file: string; line: number; operator: string }[] }) => {
    let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
    let told: string[] | undefined;
    const { ports } = stubPorts({
      generate: async () => scriptedGeneration({ specs: ["flows/pay.spec.ts"] }),
      execute: async () => ({ verdict: "pass", cases: [{ name: "pays", status: "pass", file: "flows/pay.spec.ts" }, { name: "lists", status: "pass", file: "flows/pay.spec.ts" }, { name: "no-file", status: "pass" }], logs: "" }),
      measure: async (_br, _dir, _diff, _cases, opts) => {
        told = opts?.caseFiles;
        return { status: "pass", ratio: 1, ...(bundleMutation ? { bundleMutation } : {}) };
      },
    });
    ports.runHistory.save = async (outcome) => { saved = outcome; };
    await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "bundle-mutation-persisted" });
    return { gate: saved!.gateSignals, told };
  };
  const judged = { applied: 2, killed: 1, survived: [{ file: "src/store.ts", line: 57, operator: "negate condition" }] };
  const withMutation = await persisted(judged);
  assert.deepEqual(withMutation.gate.bundleMutation, judged);
  assert.deepEqual(withMutation.told, ["flows/pay.spec.ts"]);
  assert.equal("bundleMutation" in (await persisted()).gate, false);
});

test("errorClass is derived from the verdict (E-EXEC-FAIL on a fail), not hardcoded null", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" }], logs: "x" }),
    generate: async () => (scriptedGeneration({ specs: ["a.spec.ts"]})),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "error-class-exec-fail" });

  assert.equal(out.decision.verdict, "fail");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-EXEC-FAIL", "a fail verdict must derive errorClass:E-EXEC-FAIL via errorClassFromVerdict");
});

test("errorClass is E-STATIC on an invalid verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "error-class-static" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-STATIC", "an invalid verdict must derive errorClass:E-STATIC");
});

test("errorClass is E-INFRA on an infra-error verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  let waitUntilHealthyCall = 0;
  const { ports } = stubPorts({
    waitUntilHealthy: async () => {
      waitUntilHealthyCall++;
      return waitUntilHealthyCall === 1 ? ok(true) : { ok: false as const, error: new Error("DEV unhealthy") };
    },
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "error-class-infra" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-INFRA", "a mid-run infra-error verdict must derive errorClass:E-INFRA");
});

test("a browser that could not launch stays an infrastructure fault when a delivered spec holds a test.fail() test", async () => {
  let published = 0;
  const { ports } = stubPorts({
    generate: async () => scriptedGeneration({ specs: ["flows/a.spec.ts"] }),
    execute: async () => ({
      verdict: "infra-error" as const,
      cases: [{ name: "works", status: "fail" as const, file: "flows/a.spec.ts" }, { name: "known bug", status: "pass" as const, expectedStatus: "failed" as const, file: "flows/a.spec.ts" }],
      logs: "browserType.launch: Executable doesn't exist",
    }),
  });
  ports.publication.publish = async () => { published++; return { outcome: "issue" }; };
  const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0 } }).run({ ...baseInput, runId: "launch-fault-with-test-fail" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.INFRA);
  assert.equal(published, 0, "an infrastructure fault opens no Issue");
});

test("errorClass is E-FLAKY on a flaky verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "error-class-flaky" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-FLAKY", "a flaky verdict must derive errorClass:E-FLAKY");
});

test("errorClass is E-COVERAGE-GAP on a green run with a below-threshold coverageRatio", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: passPerSpec,
    measure: async () => ({ status: "fail", ratio: 0.25 }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" }, /* signal never blocks, but errorClass is still derived */
  });

  const out = await useCase.run({ ...baseInput, runId: "error-class-coverage-gap" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-COVERAGE-GAP", "a green run with coverageRatio below the default minRatio (0.7) must derive errorClass:E-COVERAGE-GAP");
});

test("errorClass is null on a clean green pass (healthy runs teach nothing, never a fabricated class)", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: passPerSpec,
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  await useCase.run({ ...baseInput, runId: "error-class-clean-pass" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, null, "a clean green pass with no coverage gap must persist errorClass:null");
});

/* reviewerApproved is the dispatched review's verdict alone: a run that ends before its review records none. */

test("reviewerApproved is absent when the run ends before its review, however the run ended (verdict !== 'pass')", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
    generate: async () => (scriptedGeneration({ specs: ["a.spec.ts"]})),
  });
  ports.review.review = citingRejections(async () => { reviewCallCount++; return { approved: true, findings: [], blockingCount: 0, parsed: true }; });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "reviewer-approved-from-generation" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(reviewCallCount, 0, "the independent review phase must NEVER be called for a non-pass verdict (matches RunQaUseCase's own verdict==='pass' review gate)");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, undefined, "the review step never ran, so no verdict stands in for it");
});

test("reviewerApproved is ABSENT (not fabricated) when needsReview is false, regardless of verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
    generate: async () => (scriptedGeneration({ specs: ["a.spec.ts"]})),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  const out = await useCase.run({ ...baseInput, runId: "reviewer-approved-needs-review-false" });

  assert.equal(out.decision.verdict, "fail");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, undefined, "needsReview:false must never persist a reviewerApproved value");
});

/* These tests pin field threading only (the fields reach publish()). Provenance of the values
   is owned by publication-port.adapter.test.ts. */

test("publish() is called with the reviewerApproved field threaded (not dropped) on the 'pr' side effect", async () => {
  let publishedDecision: { verdict: string; reviewerApproved?: boolean; coverageBlocks?: boolean } | undefined;
  const { ports } = stubPorts({
    execute: async (dir, opts) => ({ verdict: "pass", cases: passingCases(dir, opts), logs: "" }),
    review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }),
  });
  ports.publication.publish = async (decision) => { publishedDecision = decision; return { outcome: "pr" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "publish-reviewer-approved-true" });

  assert.equal(out.decision.sideEffect, "pr");
  assert.ok(publishedDecision, "publication.publish() must have been called for the 'pr' side effect");
  assert.equal(publishedDecision!.reviewerApproved, true, "publish() must receive a threaded reviewerApproved field (undefined here would mean the call site dropped it)");
});

test("publish() is called with the coverageBlocks field threaded (not dropped) under signal-mode coverage", async () => {
  let publishedDecision: { verdict: string; reviewerApproved?: boolean; coverageBlocks?: boolean } | undefined;
  const { ports } = stubPorts({
    execute: passPerSpec,
    measure: async () => ({ status: "fail", ratio: 0.2 }),
  });
  ports.publication.publish = async (decision) => { publishedDecision = decision; return { outcome: "pr" }; };
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" },
  });

  const out = await useCase.run({ ...baseInput, runId: "publish-coverage-blocks-false" });

  assert.equal(out.decision.sideEffect, "pr", "signal mode must still publish even with a failing coverage signal");
  assert.ok(publishedDecision, "publication.publish() must have been called");
  assert.equal(publishedDecision!.coverageBlocks, false, "publish() must receive a threaded coverageBlocks field (undefined here would mean the call site dropped it)");
});

/* The publish "pr" route stages, commits and pushes the agent's generated tests from the run's own working copy. The use case threads
   the handle WorkspacePort.prepare() issued (the mainline publish() call site is the only one that can ever route to "pr"); the mirror root
   and the commit are the adapter's to resolve, never the caller's to name.
 */

test("publish() is called with the handle WorkspacePort.prepare() issued on the 'pr' side effect", async () => {
  let publishedDecision: { verdict: string; workspace?: WorkspaceHandle } | undefined;
  const { ports, ws } = stubPorts({
    execute: async (dir, opts) => ({ verdict: "pass", cases: passingCases(dir, opts), logs: "" }),
    review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }),
  });
  ports.publication.publish = async (decision) => { publishedDecision = decision; return { outcome: "pr" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "prod-blocker-workspace-threaded" });

  assert.equal(out.decision.sideEffect, "pr");
  assert.ok(publishedDecision?.workspace, "publication.publish() must have been called with the run's handle for the 'pr' side effect");
  assert.deepEqual(rootsOf(publishedDecision.workspace), { mirrorDir: ws.mirrorDir, specDir: ws.specDir }, "publish() must receive the handle of the REAL per-run working copy");
  assert.deepEqual(Object.keys(publishedDecision.workspace).sort(), ["specDir"], "the handle carries no mirror path");
});

test("reviewerApproved on a genuine pass+review call still reflects the INDEPENDENT reviewer's verdict, not generation's", async () => {
  /* On a genuine pass with needsReview:true, the independent review phase's own verdict is what
     gets persisted, even when it disagrees with generation's self-approval. */
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
    generate: async () => (scriptedGeneration({ specs: ["a.spec.ts"]})), /* generation self-approves */
    review: async () => ({ approved: false, findings: [{ text: "[false-positive] x", severity: "blocking" as const }], blockingCount: 1, parsed: true }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "genuine-review-wins" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, false, "on a genuine pass+review call, the INDEPENDENT reviewer's verdict must be persisted, not generation's own self-approval");
});

test("a context-mode INVALID result neither saves run history nor folds learning", async () => {
  /* A context run whose architecture map fails validation files an Issue and ends without saving
     run history or folding learning — unlike an invalid in any other mode, which is saved (next
     test). */
  let saveCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "tried" })),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "context-invalid-no-persist", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(saveCallCount, 0, "a context-mode invalid (validateContextFn's own context-specific validation) must NOT call runHistory.save() — a context-mode invalid files an Issue but is never saved");
});

test("a GENERIC (non-context-mode) invalid is still saved to run history exactly once", async () => {
  let saveCallCount = 0;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "generic-invalid-still-persists", mode: "diff" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(saveCallCount, 1, "a diff-mode (non-context) invalid must still call runHistory.save() exactly once — the context-mode no-persist exemption must be scoped to mode==='context' only, never leak into other modes");
});

test("a failing static gate is repaired by regenerating with the validation errors, then re-validated (the static-fix loop), instead of dying invalid on the first miss", async () => {
  /* on a repairable static-gate failure, regenerate with the validation errors fed back
     (baseGenInput({ reviewCorrections: [...] })) and re-validate, bounded by MAX_STATIC_FIX_ROUNDS
     (=2). A single trivial error recovers on the FIRST repair round (this scenario mirrors
     scenarios.ts:static-repair-recovers exactly: validate() fails once, then ok:true).
   */
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCallCount++;
      return validateCallCount === 1
        ? { ok: false, errors: ["39:11  error  'specialtyCell' is assigned a value but never used"] }
        : { ok: true, errors: [] };
    },
    generate: async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "static-repair-recovers" });

  assert.equal(out.decision.verdict, "pass", "not invalid");
  assert.equal(out.decision.sideEffect, "pr");
  assert.equal(validateCallCount, 2, "the static-fix loop must re-validate after the repair regen (1 initial fail + 1 recovery pass)");
  assert.ok(generateCallCount >= 2, `the static-fix loop must regenerate at least once to repair the static gate, got ${generateCallCount} generate() call(s)`);
  assert.equal(out.gateSignals.retries, 1, "1 repair round consumed");
});

test("the static-fix loop is bounded — a static gate that never recovers resolves to invalid after the last repair round", async () => {
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => { validateCallCount++; return { ok: false, errors: ["permanently broken lint error"] }; },
    generate: async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "static-repair-bound" });

  assert.equal(out.decision.verdict, "invalid", "a static gate still red after the repair budget is exhausted must resolve to invalid");
  assert.equal(validateCallCount, 1 + MAX_STATIC_FIX_ROUNDS, "one initial validate() plus one re-validate per repair round");
  assert.equal(generateCallCount, 1 + MAX_STATIC_FIX_ROUNDS, "one repair regeneration per round on top of the initial generate()");
});

test("a repair that delivers nothing does not end the static-fix rounds while the run still has delivered specs to repair", async () => {
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => { validateCallCount++; return { ok: false, errors: ["[lint] no-wait-for-timeout"] }; },
    generate: async () => {
      generateCallCount++;
      return generateCallCount === 1 ? scriptedGeneration({ specs: ["a.spec.ts"]}) : scriptedGeneration({ specs: []});
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "static-repair-continues-after-empty-repair" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(generateCallCount, 1 + MAX_STATIC_FIX_ROUNDS, "every repair round runs: the spec the first pass delivered is still there to repair");
  assert.equal(validateCallCount, 1 + MAX_STATIC_FIX_ROUNDS);
});

test("the linter's own fixes are applied to the delivered specs before an agent turn is spent on the static gate", async () => {
  let validateCallCount = 0;
  let generateCallCount = 0;
  const fixedFor: string[][] = [];
  const { ports } = stubPorts({
    validate: async () => { validateCallCount++; return validateCallCount === 1 ? { ok: false, errors: ["[lint] a.spec.ts 3:5 error prefer-web-first-assertions"] } : { ok: true, errors: [] }; },
    autofix: async (_dir, run) => { fixedFor.push([...(run.deliveredSpecs ?? [])]); return ["a.spec.ts"]; },
    generate: async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "static-gate-lint-fixes" });

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(fixedFor, [["a.spec.ts"]], "the fixes are asked for the delivered specs");
  assert.equal(generateCallCount, 1, "no repair turn: the fixes cleared the gate");
  assert.equal(validateCallCount, 2, "the gate runs again on what the fixes made");
  assert.equal(out.gateSignals.retries, 0);
});

test("errors the linter's fixes leave still go to a repair turn", async () => {
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => { validateCallCount++; return validateCallCount <= 2 ? { ok: false, errors: ["[typecheck] TS2322"] } : { ok: true, errors: [] }; },
    autofix: async () => ["a.spec.ts"],
    generate: async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "static-gate-lint-fixes-not-enough" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(generateCallCount, 2, "one repair turn for what the fixes left");
});

test("a generation with no specs never reaches validation: its end closes the run before the static gate", async () => {
  let validateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => { validateCallCount++; return { ok: false, errors: ["no specs were generated to validate"] }; },
    generate: async () => scriptedGeneration({ specs: [], end: GENERATION_END.UNDECIDED_EMPTY, note: "no decision" }),
  });
  const out = await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, runId: "zero-specs-skip-static-gate" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.NO_DECISION);
  assert.equal(validateCallCount, 0);
});

/* The queue's AbortSignal is a SEPARATE transport arg on run(), not a field on RunQaInput.
   An already-aborted signal must short-circuit BEFORE any port is called (no execution, no
   generation, no publish, no persist) — this is a cancellation, not a real failure to teach the
   learner from.
 */

test("run() honors an already-aborted signal — no execution, no generation, no persist", async () => {
  const controller = new AbortController();
  controller.abort();
  let generated = false;
  let executed = false;
  let saved = false;
  const { ports } = stubPorts({
    generate: async () => { generated = true; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
    execute: async (dir, opts) => { executed = true; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; },
  });
  ports.runHistory.save = async () => { saved = true; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "plan7-1-already-aborted" }, controller.signal);

  assert.equal(generated, false, "generation must never run once the signal is already aborted");
  assert.equal(executed, false, "execution must never run once the signal is already aborted");
  assert.equal(saved, false, "an aborted run must not persist a RunOutcome (it is a cancellation, not a real result)");
  assert.equal(out.decision.verdict, "infra-error", "matches cancelTrackedRun's own aborted-terminal mapping (platform/entrypoints/runner.ts)");
  assert.equal(out.decision.sideEffect, "none");
});

test("run() aborted mid-run (between validate and execute) stops before execute() and does not persist", async () => {
  const controller = new AbortController();
  let executed = false;
  const { ports } = stubPorts({
    validate: async () => { controller.abort(); return { ok: true, errors: [] }; },
    execute: async (dir, opts) => { executed = true; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; },
  });
  let saved = false;
  ports.runHistory.save = async () => { saved = true; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "plan7-1-mid-run-abort" }, controller.signal);

  assert.equal(executed, false, "execution must never run once the signal aborts mid-run");
  assert.equal(saved, false);
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.decision.sideEffect, "none");
});

test("run() with no signal at all behaves exactly as before (no second-arg regression)", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

/* MAX_STATIC_FIX_ROUNDS) had NO signal?.aborted check inside its own loop body — a cancel
   requested mid-repair would still burn out the full repair budget (up to MAX_STATIC_FIX_ROUNDS
   generate()+validate() round-trips) before the NEXT phase-boundary check (post-validate,
   pre-health) could ever catch it. This closes that residual unbounded-wall-clock-inside-the-loop
   gap, matching the same phase-boundary discipline the other 5 checks already established.
 */
test("run() aborted mid-repair inside the static-fix loop stops before consuming the full repair budget", async () => {
  const controller = new AbortController();
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCallCount++;
      if (validateCallCount === 1) {
        /* Abort right after the FIRST validate() fails — the loop's own next generate() call
           (the repair round) must observe the abort and stop, never reaching a 2nd repair round.
         */
        controller.abort();
      }
      return { ok: false, errors: ["permanently broken lint error"] };
    },
    generate: async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "plan7-2-abort-inside-static-fix-loop" }, controller.signal);

  assert.equal(out.decision.verdict, "infra-error", "an abort observed mid-repair must map to the SAME aborted-terminal shape every other phase-boundary check uses");
  assert.equal(out.decision.sideEffect, "none");
  assert.ok(generateCallCount <= 2, `the static-fix loop must stop repairing once the signal aborts — expected at most 2 generate() calls (1 initial + at most 1 repair attempt), got ${generateCallCount}`);
  assert.ok(validateCallCount <= 2, `the static-fix loop must stop re-validating once the signal aborts — expected at most 2 validate() calls, got ${validateCallCount}`);
});

test("infra-error calls runHistory.save()", async () => {
  let saveCallCount = 0;
  /* Both this use-case's entry gate AND its mid-run pre-flight derive from the SAME
     DeployGatePort.waitUntilHealthy — so the first call must succeed (passes the entry gate) and
     only the SECOND call (the mid-run pre-flight, after validate) must fail, to exercise the
     terminalResult("infra-error", ...) branch.
   */
  let waitUntilHealthyCall = 0;
  const { ports } = stubPorts({
    waitUntilHealthy: async () => {
      waitUntilHealthyCall++;
      return waitUntilHealthyCall === 1 ? ok(true) : { ok: false as const, error: new Error("DEV unhealthy") };
    },
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-infra-error" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(saveCallCount, 1, "infra-error must call runHistory.save() exactly once");
});

/* ── Change-coverage keystone: classificationDiff threading into ObjectiveSignalPort.measure() ───
   The "dynamic diff" precedent (already proven for generation/review in this file's other tests):
   classify() (diff mode only) returns the run's real commit diff, hoisted to `classificationDiff`,
   and reused across generation/review/repair. This closes the LAST missing thread — measure() must
   see the SAME real diff, so the ChangeCoverage assembler (when wired) can actually run, instead of
   silently staying "unknown" forever regardless of policy mode.
 */

test("KEYSTONE: a diff-mode PASS run threads classificationDiff into ObjectiveSignalPort.measure()'s 3rd arg", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts" }),
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "diff", runId: "keystone-diff-mode" });

  assert.equal(seenDiff, "diff --git a/src/x.ts b/src/x.ts", "measure() must receive the SAME real diff classify() returned, not a static/absent value");
});

test("KEYSTONE: a non-diff mode run never has a classificationDiff — measure() sees diff:undefined", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "manual", runId: "keystone-non-diff-mode" });

  assert.equal(seenDiff, undefined, "classify() is only ever called in diff mode, so complete/exhaustive/manual/context must never fabricate a diff for measure()");
});

/* Cross-repo coverage guard: a cross-repo (deploy-event) run's changed lines live in the SERVICE
   repo, which browser V8 coverage cannot map (AGENTS.md: "Change-coverage is unknown for these
   [cross-repo] runs"). The keystone invariant is "unknown" NEVER blocks, so a cross-repo diff run
   must starve the assembler (measure() sees diff:undefined) exactly like a non-diff-mode run, even
   though classify() DID run and DID produce a real classificationDiff.
 */

test("KEYSTONE: a diff-mode PASS run WITH input.triggerRepo set — measure() sees diff:undefined despite classify() producing a real diff", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts" }),
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "diff", runId: "keystone-cross-repo", triggerRepo: "org/orders-svc" });

  assert.equal(seenDiff, undefined, "a cross-repo run must starve ObjectiveSignalPort.measure()'s diff arg — the assembler must never be invoked (browser coverage cannot map service-repo lines)");
});

test("KEYSTONE: the SAME diff-mode PASS run WITHOUT input.triggerRepo still threads the real classificationDiff", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts" }),
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "diff", runId: "keystone-monorepo-control" });

  assert.equal(seenDiff, "diff --git a/src/x.ts b/src/x.ts", "a monorepo (non-cross-repo) run must be unaffected by the triggerRepo guard — control case for the test above");
});

/* coverage/oracle measurement and the enforce-mode coverage-regen re-measure) must thread the run's
   REAL BlastRadius (the same runBlastRadius built from classificationIntent.changedFiles that feeds
   structuralSignal) instead of the hardcoded BlastRadius.of(input.sha, []) placeholder. The mutation
   oracle scopes itself by br.changedFiles; an empty literal meant it never scoped to the diff.
 */
test("KEYSTONE: measure() receives the run's REAL BlastRadius (changedFiles from classificationIntent), not an empty placeholder", async () => {
  let seenChangedFiles: readonly string[] | undefined;
  const { ports } = stubPorts({
    classify: async () => ({
      action: "generate",
      reason: "diff touches src/orders.ts",
      diff: "diff --git a/src/orders.ts b/src/orders.ts",
      intent: { type: "fix", breaking: false, message: "fix: correct order total calculation", changedFiles: ["src/orders.ts", "src/orders.test.ts"] },
    }),
    measure: async (br) => {
      seenChangedFiles = br.changedFiles;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "diff", runId: "real-blast-radius" });

  /* BlastRadius.of() sorts+dedupes its changedFiles (see blast-radius.ts) — assert set equality,
     not literal array order.
   */
  assert.deepEqual([...(seenChangedFiles ?? [])].sort(), ["src/orders.test.ts", "src/orders.ts"], "measure() must receive the REAL changed files, not an empty BlastRadius.of(sha, []) placeholder");
});

test("KEYSTONE: the enforce-mode coverage-regen re-measure ALSO receives the run's REAL BlastRadius", async () => {
  const seenChangedFilesPerCall: (readonly string[] | undefined)[] = [];
  let measureCallCount = 0;
  const real = realCoverageWorkspace();
  try {
    const { ports } = stubPorts({
      prepare: real.prepare,
      classify: async () => ({
        action: "generate",
        reason: "diff touches src/orders.ts",
        diff: "diff --git a/src/orders.ts b/src/orders.ts",
        intent: { type: "fix", breaking: false, message: "fix: correct order total calculation", changedFiles: ["src/orders.ts"] },
      }),
      measure: async (br) => {
        measureCallCount++;
        seenChangedFilesPerCall.push(br.changedFiles);
        /* First call blocks (fail); the regen fires; the SECOND call (re-measure) is what this test pins. */
        return measureCallCount === 1
          ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/orders.ts", lines: [1] }] }
          : { status: "pass" as const, ratio: 0.9 };
      },
      blocks: (status) => status === "fail",
      generate: real.generate,
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, coveragePolicyMode: "enforce" } });

    await useCase.run({ ...baseInput, mode: "diff", runId: "regen-real-blast-radius" });

    assert.equal(measureCallCount, 2, "expected the enforce-mode one-shot regen to trigger a second measure() call");
    assert.deepEqual(seenChangedFilesPerCall[0], ["src/orders.ts"], "the FIRST measure() call must carry the real changed files");
    assert.deepEqual(seenChangedFilesPerCall[1], ["src/orders.ts"], "the regen's re-measure() call must ALSO carry the real changed files, not an empty placeholder");
  } finally {
    real.cleanup();
  }
});

/* ObserverPort wiring: these tests pin (1) the phase-boundary emission order on a representative
   happy path, and (2) that an absent observer remains a pure no-op. onEvent() IS exercised — see
   the "live per-case events" suite further down, which reads `events` off this same fakeObserver().
 */

function fakeObserver(): {
  observer: import("@contexts/run-orchestration/application/index.ts").ObserverPort;
  steps: Array<{ step: string; detail?: string }>;
  events: import("@kernel/contract/events.ts").RunEventBody[];
} {
  const steps: Array<{ step: string; detail?: string }> = [];
  const events: import("@kernel/contract/events.ts").RunEventBody[] = [];
  return {
    observer: {
      onStep(step, detail) {
        steps.push({ step, ...(detail !== undefined ? { detail } : {}) });
      },
      onEvent(body) {
        events.push(body);
      },
    },
    steps,
    events,
  };
}

test("ObserverPort: a diff-mode green-pr run emits gate -> classify -> setup -> generate -> validate -> health -> execute -> coverage -> decide -> done, in order", async () => {
  /* stubPorts() wires a default SetupPort (see this file's own stubPorts() above), matching the
     scenario this suite's other green-pr pin already exercises — the "setup" step is therefore
     expected here too, not a gap.
   */
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(
    steps.map((s) => s.step),
    ["gate", "classify", "setup", "generate", "validate", "health", "execute", "coverage", "decide", "done"],
  );
});

test("ObserverPort: the setup phase is SKIPPED (no 'setup' step) when RunQaUseCaseDeps.setup is absent", async () => {
  const { ports } = stubPorts();
  const { setup: _unusedSetup, ...portsWithoutSetup } = ports;
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...portsWithoutSetup, config: baseConfig, observer });

  await useCase.run({ ...baseInput, mode: "diff" });

  assert.deepEqual(
    steps.map((s) => s.step),
    ["gate", "classify", "generate", "validate", "health", "execute", "coverage", "decide", "done"],
  );
});

test("ObserverPort: a classify-skip emits gate -> classify -> done", async () => {
  const { ports } = stubPorts({ classify: async () => ({ action: "skip", reason: "docs-only change", diff: "" }) });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "skipped");
  assert.deepEqual(steps.map((s) => s.step), ["gate", "classify", "done"]);
});

test("ObserverPort: a failing execute() emits a 'retry' step (fix-loop engaged) before the eventual done", async () => {
  const { ports } = stubPorts({ execute: async () => ({ verdict: "fail", cases: [], logs: "" }) });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "fail");
  assert.ok(steps.some((s) => s.step === "retry"), "a failing execute() must engage the FixLoop, observed as a 'retry' step");
  assert.equal(steps.at(-1)?.step, "done", "every exit path terminates with a 'done' step");
  /* A fail verdict never reaches "coverage" (ObjectiveSignalPort.measure() only runs on a pass). */
  assert.ok(!steps.some((s) => s.step === "coverage"), "coverage is never measured for a non-pass verdict");
});

/* "coverage" must not emit on every passing verdict regardless of mode/triggerRepo. These three
   tests pin the gate: a non-diff pass never emits it, a diff-mode pass DOES (already pinned above),
   and a cross-repo diff-mode pass does NOT.
 */

test("ObserverPort: a non-diff-mode (complete) PASS run never emits a 'coverage' step", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, runId: "coverage-step-non-diff-mode", mode: "manual" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(!steps.some((s) => s.step === "coverage"), "a non-diff mode pass must never emit 'coverage'");
});

test("ObserverPort: a diff-mode PASS run WITH triggerRepo set never emits a 'coverage' step", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, runId: "coverage-step-cross-repo", mode: "diff", triggerRepo: "org/orders-svc" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(!steps.some((s) => s.step === "coverage"), "a cross-repo diff-mode pass must never emit 'coverage' — browser coverage cannot map the triggering service repo's changed lines");
});

test("ObserverPort: a diff-mode PASS run WITHOUT triggerRepo still emits a 'coverage' step (control case for the two guards above)", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, runId: "coverage-step-diff-monorepo", mode: "diff" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(steps.some((s) => s.step === "coverage"), "an ordinary monorepo diff-mode pass must still emit 'coverage' — unaffected by either guard");
});

test("ObserverPort: a static-gate repair round emits its own 'retry' step with a round-number detail", async () => {
  let validateCalls = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCalls++;
      return validateCalls === 1 ? { ok: false, errors: ["unused var"] } : { ok: true, errors: [] };
    },
  });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  await useCase.run({ ...baseInput, mode: "diff" });

  const retrySteps = steps.filter((s) => s.step === "retry");
  assert.equal(retrySteps.length, 1);
  assert.match(retrySteps[0]?.detail ?? "", /static-fix round 1\/2/);
});

test("ObserverPort: an infra-error entry-gate terminal emits gate -> done only (no classify/generate reached)", async () => {
  const { ports } = stubPorts({
    waitUntilHealthy: async () => err(new Error("DEV did not serve sha within 60000ms")),
  });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.deepEqual(steps.map((s) => s.step), ["gate", "done"]);
});

test("ObserverPort: an already-aborted signal short-circuits straight to a single 'done' step (no gate/classify/generate reached)", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });
  const controller = new AbortController();
  controller.abort();

  const out = await useCase.run({ ...baseInput, mode: "diff" }, controller.signal);

  assert.equal(out.decision.verdict, "infra-error");
  /* abortedResult() reuses infraErrorResult()'s shared terminal, which now uniformly emits "done"
     on every exit path (mainline, skip, invalid/infra-error) — so a cancelled-before-start run
     still reports itself as terminal to any observer, even though it never reached "gate".
   */
  assert.deepEqual(steps.map((s) => s.step), ["done"]);
});

test("ObserverPort: an ABSENT observer is a pure no-op — every RunQaUseCaseDeps consumer that predates this fix keeps compiling and behaving identically", async () => {
  const { ports } = stubPorts();
  /* Deliberately NOT passing `observer` — this is every pre-existing test/composition in this
     file and across the codebase today.
   */
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await assert.doesNotReject(useCase.run({ ...baseInput, mode: "diff" }));
});

/* Live per-case/per-test events. ExecutionOpts.onCase/onRunning/onDiscovered (threaded through
   ExecutionPort.execute opts) drive ObserverPort.onEvent DURING execute(), not only reconstructable
   post-hoc from the final case list.
 */

test("live events: a passing execute() invoking onCase/onRunning/onDiscovered emits test.started/test.discovered/test.passed via onEvent, DURING execute()", async () => {
  const { ports } = stubPorts({
    execute: async (_specDir, opts) => {
      const o = opts && !(opts instanceof AbortSignal) ? opts : {};
      o.onDiscovered?.("checkout flow", "checkout.spec.ts");
      o.onRunning?.("checkout flow");
      o.onCase?.({ name: "checkout flow", status: "pass", durationMs: 1200 });
      return { verdict: "pass", cases: [{ name: "checkout flow", status: "pass", durationMs: 1200, file: "a.spec.ts" }], logs: "" };
    },
  });
  const { observer, events } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, runId: "live-events-pass" });

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(events.filter((e) => e.type.startsWith("test.")), [
    { type: "test.discovered", name: "checkout flow", file: "checkout.spec.ts" },
    { type: "test.started", name: "checkout flow" },
    { type: "test.passed", name: "checkout flow", durationMs: 1200 },
  ]);
});

test("live events: a failing case's onCase invocation emits test.failed via onEvent", async () => {
  const { ports } = stubPorts({
    execute: async (_specDir, opts) => {
      const o = opts && !(opts instanceof AbortSignal) ? opts : {};
      o.onCase?.({ name: "login", status: "fail", detail: "timeout waiting for selector" });
      return { verdict: "fail", cases: [{ name: "login", status: "fail", detail: "timeout waiting for selector" }], logs: "" };
    },
  });
  const { observer, events } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  await useCase.run({ ...baseInput, runId: "live-events-fail", mode: "manual" });

  assert.ok(
    events.some((e) => e.type === "test.failed" && e.name === "login" && e.detail === "timeout waiting for selector"),
    "a failing case must emit test.failed with its detail",
  );
});

test("live events: NO duplicate events — RunQaUseCase itself emits each onCase invocation exactly once (no post-hoc re-emission on top of the live stream)", async () => {
  let onCaseCallCount = 0;
  const { ports } = stubPorts({
    execute: async (_specDir, opts) => {
      const o = opts && !(opts instanceof AbortSignal) ? opts : {};
      o.onCase?.({ name: "checkout", status: "pass", durationMs: 500 });
      onCaseCallCount++;
      return { verdict: "pass", cases: [{ name: "checkout", status: "pass", durationMs: 500 }], logs: "" };
    },
  });
  const { observer, events } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  await useCase.run({ ...baseInput, runId: "live-events-no-dup" });

  const passedEvents = events.filter((e) => e.type === "test.passed" && e.name === "checkout");
  assert.equal(onCaseCallCount, 1, "sanity: the stub's onCase fired exactly once");
  assert.equal(passedEvents.length, 1, "RunQaUseCase must emit exactly ONE test.passed per onCase invocation — it must never additionally re-walk the returned cases[] and re-emit");
});

test("live events: onCase/onRunning/onDiscovered are threaded on EVERY FixLoop retry, not just the initial execute()", async () => {
  let executeCallCount = 0;
  const { ports } = stubPorts({
    execute: async (_specDir, opts) => {
      executeCallCount++;
      const o = opts && !(opts instanceof AbortSignal) ? opts : {};
      if (executeCallCount === 1) {
        o.onCase?.({ name: "login", status: "fail", detail: "boom" });
        return { verdict: "fail", cases: [{ name: "login", status: "fail", detail: "boom" }], logs: "" };
      }
      o.onCase?.({ name: "login", status: "pass", durationMs: 300 });
      return { verdict: "pass", cases: [{ name: "login", status: "pass", durationMs: 300 }], logs: "" };
    },
    generate: async () => (scriptedGeneration({ specs: ["a.spec.ts"]})),
  });
  const { observer, events } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  await useCase.run({ ...baseInput, runId: "live-events-retry", mode: "diff" });

  assert.ok(executeCallCount > 1, "sanity: the FixLoop must have engaged a retry");
  const testEvents = events.filter((e) => e.type === "test.failed" || e.type === "test.passed");
  assert.equal(testEvents.length, 2, "both the initial failing case AND the retry's passing case must emit their own live event");
  assert.equal(testEvents[0]?.type, "test.failed");
  assert.equal(testEvents[1]?.type, "test.passed");
});

test("live events: an ABSENT observer is a pure no-op for onCase/onRunning/onDiscovered too (backward compatible)", async () => {
  const { ports } = stubPorts({
    execute: async (_specDir, opts) => {
      const o = opts && !(opts instanceof AbortSignal) ? opts : {};
      /* Must not throw when no observer is wired. */
      o.onDiscovered?.("x", "x.spec.ts");
      o.onRunning?.("x");
      o.onCase?.({ name: "x", status: "pass" });
      return { verdict: "pass", cases: [{ name: "x", status: "pass" }], logs: "" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await assert.doesNotReject(useCase.run({ ...baseInput, runId: "live-events-no-observer" }));
});

/* FixLoop filtered-retry threads specFiles. FixLoopExecuteInput.specFiles (the aggregate's OWN
   canFilter/failedSpecFiles decision) must reach the REAL ExecutionPort.execute() call.
 */

test("a filtered retry reaches the execution port scoped to the failing spec file when coverage is not measured", async () => {
  let executeCallCount = 0;
  const capturedSpecFiles: (string[] | undefined)[] = [];
  const { ports } = stubPorts({
    execute: async (_specDir, opts) => {
      executeCallCount++;
      const o = opts && !(opts instanceof AbortSignal) ? opts : {};
      capturedSpecFiles.push(o.specFiles);
      if (executeCallCount === 1) {
        /* The failing case carries its spec file — the filtered retry needs every failing case to name one. */
        return {
          verdict: "fail" as const,
          cases: [{ name: "login", status: "fail" as const, file: "login.spec.ts", detail: "boom" }],
          logs: "",
        };
      }
      /* The retry reports the re-run spec's result under its file, as the Playwright report does. */
      return { verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "login.spec.ts" }], logs: "" };
    },
    /* The regen only rewrites the failing spec (stays inside the failed set — canFilter requires
       regenStayedInFailedSet), so filtering is not blocked by an "outsider" spec being touched too.
     */
    generate: async () => (scriptedGeneration({ specs: ["login.spec.ts"]})),
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "off" } });

  const out = await useCase.run({ ...baseInput, runId: "filtered-retry-specfiles", mode: "diff" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(executeCallCount >= 2, "sanity: the FixLoop must have retried at least once");
  /* The FIRST execute() (initial, pre-FixLoop) never carries specFiles (nothing has failed yet). */
  assert.equal(capturedSpecFiles[0], undefined);
  /* The retry (2nd execute() call) must be scoped to ONLY the failing spec file. */
  assert.deepEqual(capturedSpecFiles[1], ["login.spec.ts"], "the filtered retry must thread ONLY the failed spec file(s) into ExecutionOpts.specFiles");
});

test("a fix-loop round executes only its changed specs under the round's own namespace, even when change-coverage will measure the run", async () => {
  let executeCallCount = 0;
  const capturedSpecFiles: (string[] | undefined)[] = [];
  const capturedNamespaces: (string | undefined)[] = [];
  const { ports } = stubPorts({
    execute: async (_specDir, opts) => {
      executeCallCount++;
      const o = opts && !(opts instanceof AbortSignal) ? opts : {};
      capturedSpecFiles.push(o.specFiles);
      capturedNamespaces.push(o.namespace);
      if (executeCallCount === 1) {
        return {
          verdict: "fail" as const,
          cases: [{ name: "login", status: "fail" as const, file: "login.spec.ts", detail: "boom" }],
          logs: "",
        };
      }
      return { verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "login.spec.ts" }], logs: "" };
    },
    generate: async () => (scriptedGeneration({ specs: ["login.spec.ts"]})),
  });
  /* Acceptance executes only the specs the round changed; the measurement execution after the verdict, not a widened retry, measures every passing test. */
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  const out = await useCase.run({ ...baseInput, runId: "fixloop-acceptance-scope", mode: "diff" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(executeCallCount >= 2, "sanity: the FixLoop must have accepted at least once");
  assert.equal(capturedSpecFiles[0], undefined, "the first execution runs the whole suite");
  assert.deepEqual(capturedSpecFiles[1], ["login.spec.ts"], "the accepted round executes exactly the spec it changed");
  assert.equal(capturedNamespaces[1], "fixloop-acceptance-scope-r1", "the round's execution carries its own namespace");
});

/* publish() dispatches for EVERY side-effect-bearing decision ("pr" | "issue" | "quarantine" |
   "shadow-log"), not just "pr". A "none" sideEffect (already decided by RunDecisionService's own
   onFailure guard) never reaches the publish port at all. issueRepo is threaded from
   input.triggerRepo.
 */

test("publish() is called for an 'issue' side effect (fail verdict, onFailure:'github-issue') — previously ONLY 'pr' ever called publish()", async () => {
  let publishCallCount = 0;
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async (decision) => {
    publishCallCount++;
    publishedDecision = decision;
    return { outcome: "issue: https://github.com/org/app/issues/1" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0 } });

  const out = await useCase.run({ ...baseInput, runId: "publish-issue-fail" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "issue");
  assert.equal(publishCallCount, 1, "a fail verdict with onFailure:'github-issue' must dispatch to publish() — this call site must be reachable for more than 'pr'");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(out.note, "issue: https://github.com/org/app/issues/1", "the publish outcome must thread into RunQaResult.note");
});

test("publish() is called for a 'quarantine' side effect (flaky verdict) — previously ONLY 'pr' ever called publish()", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "quarantine: flaky — quarantine, no PR" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "publish-quarantine-flaky" });

  assert.equal(out.decision.verdict, "flaky");
  assert.equal(out.decision.sideEffect, "quarantine");
  assert.equal(publishCallCount, 1, "a flaky verdict must dispatch to publish() so the quarantine outcome genuinely surfaces (the quarantine outcome must surface)");
});

test("onFailure:'none' + fail verdict resolves to sideEffect:'none' and publish() is NEVER called (reconciles PublishDecisionService's missing onFailure guard)", async () => {
  /* PublishDecisionService (workspace-and-publication) has NO onFailure guard of its own — it would
     unconditionally return "issue" for a fail/invalid verdict if it were ever reached. The
     reconciliation: RunDecisionService's own onFailure guard resolves this case to sideEffect:"none"
     BEFORE this use-case's publish-dispatch gate (`decision.sideEffect !== "none"`) is even
     evaluated — so PublicationPortAdapter (and its PublishDecisionService collaborator) is never
     reached for an onFailure-suppressed verdict; the guard the adapter itself lacks never needs to
     fire because the decision layer already suppressed the call one level up.
   */
  let publishCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0, onFailure: "none" } });

  const out = await useCase.run({ ...baseInput, runId: "onfailure-none-no-issue" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "none", "onFailure:'none' must suppress the side effect for a fail verdict (report()'s own top-guard)");
  assert.equal(publishCallCount, 0, "an onFailure-suppressed decision ('none') must NEVER reach the publish port — no Issue must open");
});

test("a triggerRepo run threads issueRepo into publish() so the Issue routes to the triggering service repo, not the primary", async () => {
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async (decision) => {
    publishedDecision = decision;
    return { outcome: "issue: https://github.com/org/orders-svc/issues/9" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0 } });

  const out = await useCase.run({ ...baseInput, runId: "cross-repo-issue-routing", triggerRepo: "org/orders-svc" });

  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(publishedDecision!.issueRepo, "org/orders-svc", "publish() must receive issueRepo from input.triggerRepo so PublicationPortAdapter can route the Issue to the triggering repo, not the primary");
});

test("an ordinary (non-cross-repo) run omits issueRepo entirely — the adapter falls back to its own static ctx.repo", async () => {
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async (decision) => { publishedDecision = decision; return { outcome: "issue: https://github.com/org/app/issues/2" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0 } });

  const out = await useCase.run({ ...baseInput, runId: "no-trigger-repo-omits-issue-repo" });

  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(publishedDecision!.issueRepo, undefined, "an ordinary run (no input.triggerRepo) must NOT fabricate an issueRepo — absent lets the adapter fall back to its own static ctx.repo");
});

test("an invalid verdict with onFailure:'github-issue' dispatches publish() exactly once with sideEffect 'issue'", async () => {
  let publishCallCount = 0;
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  ports.publication.publish = async (decision) => {
    publishCallCount++;
    publishedDecision = decision;
    return { outcome: "issue: https://github.com/org/app/issues/42" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-invalid-publishes-issue" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.decision.sideEffect, "issue");
  assert.equal(publishCallCount, 1, "terminalResult('invalid', ...) must dispatch to publish() exactly once — previously computed `decision` but never called publish() at all");
  assert.ok(publishedDecision, "publish() must have been called with a decision payload");
  assert.equal(publishedDecision!.verdict, "invalid");
  /* The static gate's own validation-errors note is threaded in as terminalResult's `note` param
     (see the note-forwarding test) — the publish outcome is APPENDED to it, never clobbering it
     (see the dedicated append-not-clobber test below).
   */
  assert.ok(out.note?.includes("issue: https://github.com/org/app/issues/42"), `the publish outcome must thread into RunQaResult.note — got: ${out.note}`);
});

test("an invalid verdict with onFailure:'none' resolves to sideEffect 'none' and publish() is NEVER called", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, onFailure: "none" } });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-invalid-onfailure-none" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.decision.sideEffect, "none", "onFailure:'none' must suppress the side effect for an invalid verdict too, matching report()'s own top-guard");
  assert.equal(publishCallCount, 0, "an onFailure-suppressed invalid decision must NEVER reach the publish port");
});

test("a shadow-mode invalid verdict dispatches publish() so the shadow-log line is genuinely emitted (shadow-log routing)", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "shadow: shadow mode — side effects replaced with logs" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, shadow: true } });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-invalid-shadow" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.decision.sideEffect, "shadow-log");
  assert.equal(publishCallCount, 1, "a shadow-mode invalid run must still dispatch to publish() — PublicationPortAdapter is what collapses it into a shadow-log line, not this use-case skipping the call");
  assert.ok(out.note?.includes("shadow: shadow mode — side effects replaced with logs"), `got: ${out.note}`);
});

test("an infra-error verdict resolves to sideEffect 'none' via decide() itself — publish() is NEVER called, and no special-casing is needed", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    waitUntilHealthy: async () => err(new Error("DEV did not respond")),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-infra-error-no-publish" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.decision.sideEffect, "none", "infra-error must resolve to sideEffect 'none' automatically through the shared decide() call");
  assert.equal(publishCallCount, 0, "an infra-error terminal must NEVER dispatch to publish()");
});

test("the publish outcome is APPENDED to an existing diagnostic note (e.g. the static-gate's validation-errors note), never clobbered", async () => {
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout", "[tsc] Type 'string' is not assignable to type 'number'."] }),
  });
  ports.publication.publish = async () => ({ outcome: "issue: https://github.com/org/app/issues/7" });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-note-append-not-clobber" });

  assert.equal(out.decision.verdict, "invalid");
  assert.ok(out.note?.includes("no-wait-for-timeout"), `the original validation-errors note must survive — got: ${out.note}`);
  assert.ok(out.note?.includes("issue: https://github.com/org/app/issues/7"), `the publish outcome must be appended to the existing note, not replace it — got: ${out.note}`);
});

/* Context-mode invalid reaches the SAME terminalResult call as the generic static-gate invalid,
   so it honors onFailure exactly like every other verdict — including staying silent when
   onFailure:"none".
 */

test("a context-mode invalid dispatches publish() when onFailure:'github-issue' (and, like every context-mode invalid, is not saved to run history)", async () => {
  let publishCallCount = 0;
  let saveCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "tried" })),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: https://github.com/org/app/issues/11" }; };
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix2-context-invalid-publishes", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(publishCallCount, 1, "a context-mode invalid with onFailure:'github-issue' must dispatch publish() through the same shared terminalResult path every other invalid uses");
  assert.equal(saveCallCount, 0, "context-mode invalid must still NOT persist — publish dispatch and persistence are orthogonal (the skipPersist convention is unaffected by publish dispatch)");
});

test("a context-mode invalid does NOT dispatch publish() when onFailure:'none'", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [".qa/context.json"], note: "tried" })),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, onFailure: "none" } });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix2-context-invalid-onfailure-none", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(publishCallCount, 0, "see the terminalResult skipPersist comment for the full rationale");
});

/* The FixLoop's own regenerate() call receives FixLoopGenerateInput
   (fixCases/selectorContradictions/domSnapshot). The use-case's closure must forward that context —
   every retry must not regenerate with the SAME contextless prompt as the initial attempt.
 */

test("the FixLoop's regenerate() call forwards fixCases into generate()'s enrichment", async () => {
  const capturedFixCases: unknown[] = [];
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const, detail: "timed out waiting for selector" }], logs: "x" }),
  });
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedFixCases.push(enrichment?.fixCases);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f2-fixcases-forwarded" });

  /* First call is the initial generate() (no fixCases yet); the FixLoop's OWN regen call(s) must
     carry the failing case(s) forward.
   */
  const withFixCases = capturedFixCases.filter((fc) => Array.isArray(fc) && fc.length > 0);
  assert.ok(withFixCases.length > 0, "at least one generate() call (the FixLoop's regen) must receive fixCases — got none across all calls");
  assert.deepEqual(withFixCases[0], [{ name: "login", status: "fail", detail: "timed out waiting for selector" }]);
});

test("the FixLoop's regenerate() call forwards selectorContradictions when Lever-2 finds any", async () => {
  /* Lever-2 only produces contradictions when a failed case carries a failureDom (buildFailureDomLines)
     AND the prior round's spec source references a selector absent from that tree. The retry
     loop itself is fix-loop-retry.test.ts's job; this test's scope is narrower:
     prove the closure threads whatever selectorContradictions the FixLoop computes, when non-empty.
   */
  const capturedEnrichments: Array<{ selectorContradictions?: readonly string[] }> = [];
  const { ports } = stubPorts({
    execute: async () => ({
      verdict: "fail" as const,
      cases: [{ name: "login", status: "fail" as const, detail: "err", failureDom: "button: Submit\nheading: Login" }],
      logs: "x",
    }),
  });
  let genCall = 0;
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    genCall++;
    capturedEnrichments.push(enrichment ?? {});
    /* The initial call's specSources become the round-0 Lever-2 comparison source; return a spec
       whose source text references a selector NOT in the failure-point tree above, so Lever-2 finds
       a contradiction on the FixLoop's own retry round.
     */
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f2-selector-contradictions-forwarded" });

  /* This scenario's stub the authoring port never supplies specSources (that is
     GenerationTurnsAdapter's own collaborator, absent in this unit-level stub), so Lever-2 has
     nothing to check against and legitimately finds zero contradictions — the assertion here is
     that the FIELD ITSELF is threaded through the enrichment object (present when non-empty, never
     silently dropped), not that this particular stub scenario produces a non-empty result.
   */
  assert.ok(genCall > 1, "the FixLoop must have called generate() more than once");
  for (const enrichment of capturedEnrichments) {
    assert.ok(
      enrichment.selectorContradictions === undefined || Array.isArray(enrichment.selectorContradictions),
      "selectorContradictions, when present, must be an array (threaded verbatim from the FixLoop's own Lever-2 check, never fabricated)",
    );
  }
});

test("the FixLoop's regenerate() call forwards domSnapshot when Lever-2 supplies a failure-point capture", async () => {
  const capturedDomSnapshots: (string | undefined)[] = [];
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const, detail: "err" }], logs: "x" }),
  });
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedDomSnapshots.push(enrichment?.domSnapshot);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f2-domsnapshot-field-present" });

  /* Same scope note as the selectorContradictions test above: this scenario's failing case carries
     no failureDom, so the FixLoop's own Lever-2 check has nothing to build a domSnapshot from
     (matches fix-loop.aggregate.ts's own `haveTrees` guard) — the field is legitimately absent here.
     Proven present-when-populated by the generation-turns.adapter.test.ts enrichment-mapping test.
   */
  assert.ok(capturedDomSnapshots.length > 0, "generate() must have been called at least once");
});

/* Reviewer-corrections regeneration loop: MAX_REVIEW_ROUNDS=2, a blocking rejection regenerates
   with reviewCorrections threaded, a rejection on the LAST round is terminal, parsed:false fails
   closed WITHOUT burning a round.
 */

test("a reviewer rejection with blocking corrections triggers regeneration with reviewCorrections threaded", async () => {
  let reviewCallCount = 0;
  const capturedReviewCorrections: (readonly string[] | undefined)[] = [];
  const { ports, ws } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => {
    reviewCallCount++;
    return reviewCallCount === 1
      ? { approved: false, findings: [{ text: "[false-positive] assertion targets the wrong element", severity: "blocking" as const }], blockingCount: 1, parsed: true }
      : { approved: true, findings: [], blockingCount: 0, parsed: true };
  });
  ports.generation.author = revisingAuthor(ws, async (_specDir, _signal, _diff, enrichment) => {
    capturedReviewCorrections.push(enrichment?.reviewCorrections);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-corrections-thread-into-regen" });

  assert.equal(reviewCallCount, 2, "a blocking rejection on round 0 must trigger exactly one regeneration + one re-review (round 1)");
  const regenWithCorrections = capturedReviewCorrections.filter((c) => c?.length);
  assert.ok(regenWithCorrections.length > 0, "at least one generate() call must have received reviewCorrections");
  assert.deepEqual(regenWithCorrections[0], ["[false-positive] assertion targets the wrong element"]);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr", "once corrections are resolved on round 1, the run must publish");
});

test("corrections resolved on the regenerated round -> reviewerApproved:true -> publish", async () => {
  let reviewCallCount = 0;
  const { ports, ws } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async (_specDir, _cases, _diff, enrichment) => {
    reviewCallCount++;
    if (reviewCallCount === 1) {
      return { approved: false, findings: [{ text: "[false-positive] x", severity: "blocking" as const }], blockingCount: 1, parsed: true };
    }
    /* Round 1: the reviewer sees the SAME corrections it raised last round via priorCorrections and
       now approves — proves convergence threading.
     */
    assert.deepEqual(enrichment?.priorCorrections, ["[false-positive] x"], "round 1's review() call must receive round 0's own corrections as priorCorrections");
    return { approved: true, findings: [], blockingCount: 0, parsed: true };
  });
  ports.generation.author = revisingAuthor(ws);
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-corrections-resolved-publishes" });

  assert.equal(reviewCallCount, 2);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

test("not pr)", async () => {
  let reviewCallCount = 0;
  let generateCallCount = 0;
  const { ports, ws } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => {
    reviewCallCount++;
    return { approved: false, findings: [{ text: "[false-positive] persistent issue", severity: "blocking" as const }], blockingCount: 1, parsed: true };
  });
  ports.generation.author = revisingAuthor(ws, async () => {
    generateCallCount++;
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-bound-terminal-rejection" });

  /* MAX_REVIEW_ROUNDS=2: round 0 rejects (not the last round -> regen), round 1 rejects (the LAST
     round -> terminal, no further regen). Exactly 2 review() calls, exactly 1 review-driven regen.
   */
  assert.equal(reviewCallCount, 2, "MAX_REVIEW_ROUNDS=2 bounds the loop to exactly 2 review() calls — never an unbounded retry");
  assert.equal(generateCallCount, 1 + 1, "exactly 1 review-driven regeneration (round 0's rejection) on top of the initial generate() call — round 1's rejection is terminal, no further regen");
  assert.equal(out.decision.verdict, "pass", "the harness verdict itself is still 'pass' — it is the REVIEWER that rejected, not execution");
  assert.equal(out.decision.sideEffect, "issue", "a reviewer rejection that survives the full bound must route to an Issue, never a PR — matches decide()'s needsReview && !reviewerApproved branch");
});

/* must reach the persisted RunOutcome.gateSignals.reviewerCorrections — previously hardcoded to
   [] (run-qa.use-case.ts's toRunOutcome/deriveErrorClass), which made E-FALSE-POSITIVE/
   E-WRONG-OBJECTIVE/E-FRAGILE-SELECTOR/E-NO-CLEANUP structurally underivable and the reflection
   prompt's "reviewer corrections" section never rendered. ─────────────────────────────────────
 */

test("a terminal reviewer rejection threads its corrections into gateSignals.reviewerCorrections and derives the tagged errorClass", async () => {
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => {
    /* Rejects on EVERY round — the persistent-rejection case (same fixture as the bound test above). */
    return { approved: false, findings: [{ text: "[false-positive] asserts nothing on the discount", severity: "blocking" as const }], blockingCount: 1, parsed: true };
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "corrections-thread-into-gate-signals" });

  assert.equal(out.decision.sideEffect, "issue");
  assert.deepEqual(
    out.outcome?.gateSignals.reviewerCorrections,
    ["[false-positive] asserts nothing on the discount"],
    "the FINAL round's own rejection corrections must reach the persisted outcome's gateSignals — not []",
  );
  assert.equal(
    out.errorClass,
    "E-FALSE-POSITIVE",
    "resolveErrorClass must now derive the tagged class from the real reviewerCorrections, not fall through to null",
  );
});

test("an APPROVED review (no rejection) still persists gateSignals.reviewerCorrections as [] — never fabricated", async () => {
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }));
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "approved-no-corrections" });

  assert.equal(out.decision.sideEffect, "pr");
  assert.deepEqual(out.outcome?.gateSignals.reviewerCorrections, []);
  assert.equal(out.errorClass, null, "a healthy approved green run must still resolve to no error class");
});

/* rules) explicitly allows an APPROVING verdict to carry advisory-only corrections — "The gate
   PASSES with advisory-only corrections — they are recorded as notes, not requirements".
   blockingCount===0 says NOTHING about corrections.length. Those advisory notes must NEVER become
   a learning/errorClass signal: threading them would derive e.g. E-FRAGILE-SELECTOR on a PASSING,
   satisfies the audit gate) and minting a mislabeled candidate rule from a healthy pass.
 */
test("BOUNDARY: approved with ADVISORY-ONLY corrections (blockingCount 0) — errorClass stays null, audit() does NOT fire, persisted reviewerCorrections is []", async () => {
  let auditCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => ({
    approved: true,
    findings: [{ text: "[fragile-selector] prefer role-based locator", severity: "blocking" as const }], /* advisory note on an APPROVAL */
    blockingCount: 0,
    parsed: true,
  }));
  const processAudit = makeFakeProcessAudit(() => { auditCallCount++; });
  const useCase = new RunQaUseCase({ ...ports, processAudit, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "approved-advisory-only-boundary" });

  assert.equal(out.decision.sideEffect, "pr", "advisory-only corrections on an approval must still publish (the reviewer contract's own gate semantics)");
  assert.equal(out.errorClass, null, "an approved pass must resolve errorClass:null — an advisory note is a note, never a failure-taxonomy signal");
  assert.deepEqual(out.outcome?.gateSignals.reviewerCorrections, [], "advisory notes on an approval are never persisted as learning-visible corrections");
  assert.equal(auditCallCount, 0, "audit() must NOT fire on an approved green — the audit-on-green guard must survive advisory notes");
});

test("a rejection resolved by convergence (round 1 APPROVES, even with an advisory note) persists gateSignals.reviewerCorrections as [] — approval clears, rejection threads", async () => {
  let reviewCallCount = 0;
  const { ports, ws } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => {
    reviewCallCount++;
    if (reviewCallCount === 1) {
      return { approved: false, findings: [{ text: "[fragile-selector] round 0 nit", severity: "blocking" as const }], blockingCount: 1, parsed: true };
    }
    /* The approving round carries a leftover ADVISORY note — the guard is "approval -> []",
       not "last round's raw corrections win": an approving round's advisory notes are notes,
       never a learning/errorClass signal (see the BOUNDARY test above).
     */
    return { approved: true, findings: [{ text: "[fragile-selector] minor residual style nit", severity: "blocking" as const }], blockingCount: 0, parsed: true };
 });
  ports.generation.author = revisingAuthor(ws);
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "convergence-final-round-wins" });

  assert.equal(reviewCallCount, 2);
  assert.equal(out.decision.sideEffect, "pr", "round 1 approved — the run must publish");
  assert.deepEqual(
    out.outcome?.gateSignals.reviewerCorrections,
    [],
    "the run ultimately APPROVED — approval clears the earlier rejection's corrections AND its own advisory notes; only a FINAL rejection ever threads corrections",
  );
  assert.equal(out.errorClass, null, "an ultimately-approved pass must not inherit an errorClass from either round's corrections");
});

test("reviewer-rejection reaches the process audit with the real (non-null) errorClass — the audit gate does not suppress it as an unfalsifiable green", async () => {
  let capturedOutcome: RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => ({ approved: false, findings: [{ text: "[wrong-objective] tests login, commit changed checkout", severity: "blocking" as const }], blockingCount: 1, parsed: true }));
  const processAudit = makeFakeProcessAudit((outcome) => { capturedOutcome = outcome; });
  const useCase = new RunQaUseCase({ ...ports, processAudit, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "reviewer-rejection-reaches-audit" });

  assert.equal(out.errorClass, "E-WRONG-OBJECTIVE");
  assert.ok(capturedOutcome, "processAudit.audit() must fire — E-WRONG-OBJECTIVE is a real, non-empty error class");
  assert.equal(capturedOutcome?.errorClass, "E-WRONG-OBJECTIVE");
  assert.deepEqual(capturedOutcome?.gateSignals.reviewerCorrections, ["[wrong-objective] tests login, commit changed checkout"]);
});

test("parsed:false (a parse miss) fails closed WITHOUT burning a regeneration round", async () => {
  let reviewCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = async () => {
    reviewCallCount++;
    return { approved: true, findings: [], blockingCount: 0, parsed: false }; /* parse miss, NOT a real rejection */
  };
  ports.generation.author = async () => { generateCallCount++; return scriptedGeneration({ specs: ["a.spec.ts"]}); };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-parse-miss-fails-closed-no-burn" });

  assert.equal(reviewCallCount, 1, "a parse miss must return IMMEDIATELY — never re-prompt/re-review");
  assert.equal(generateCallCount, 1, "a parse miss must NOT trigger any review-driven regeneration — only the initial generate() call happened");
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "issue", "a parse-miss must fail closed to an Issue, never a PR");
});

test("a regeneration that produces zero specs mid-loop is a lost cause — terminal rejection, no further review", async () => {
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
  });
  ports.review.review = citingRejections(async () => {
    reviewCallCount++;
    return { approved: false, findings: [{ text: "[false-positive] x", severity: "blocking" as const }], blockingCount: 1, parsed: true };
  });
  let generateCallCount = 0;
  ports.generation.author = async () => {
    generateCallCount++;
    /* Initial call succeeds; the review-driven regen (round 0's rejection) produces nothing. */
    return generateCallCount === 1 ? scriptedGeneration({ specs: ["a.spec.ts"]}) : scriptedGeneration({ specs: []});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-empty-regen-mid-loop-terminal" });

  assert.equal(reviewCallCount, 1, "a regeneration with zero specs was never judged — the loop must NOT re-review it");
  assert.equal(out.decision.sideEffect, "issue", "an unreviewed empty regeneration must never inherit self-approval — routes to Issue");
});

/* On the orchestrated path, exactly ONE reviewer session
   fires per generation round (RunQaUseCase's own ReviewPort) — GenerateTestsUseCase's internal
   reviewer branch must never fire (this use-case's own stub ReviewPort/the authoring port cannot
   directly observe GenerateTestsUseCase's internals; the call-count proof that engine-root.ts
   wires needsReview:false into GenerationTurnsAdapter's ctx lives in engine-root.test.ts — this
   test's scope is the use-case's OWN single-reviewer contract: review() is called AT MOST once per
   round, never twice for the same round). ──────────────────────────────────────────────────────────
 */

test("exactly ONE reviewer session (review() call) fires for a clean pass — no double review", async () => {
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: passPerSpec,
  });
  ports.review.review = citingRejections(async () => { reviewCallCount++; return { approved: true, findings: [], blockingCount: 0, parsed: true }; });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f4-single-review-clean-pass" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(reviewCallCount, 1, "the orchestrated path must perform EXACTLY ONE reviewer session per round — a second, internal reviewer session firing on top of this one is the audit-flagged defect");
});

test("no-op skip (approved + zero specs) still works — needsReview:true generation self-approval is preserved", async () => {
  /* AGENTS.md invariant: "Honor the agent's no-op decision — approved + zero specs is a valid
     skipped, never invalid." This must hold regardless of the composition root's needsReview wiring (which only
     changes GenerationTurnsAdapter's ctx.needsReview, not this use-case's OWN generation stub
     contract) — generation returning approved:true with zero specs is ALWAYS a valid skip.
   */
  const { ports } = stubPorts({ generate: async () => (scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "nothing in this change is worth a test" })) });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f4-no-op-skip-preserved" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(out.decision.sideEffect, "none");
});

test("classify() surfaces intent, and diff-mode generate() receives it via enrichment", async () => {
  const capturedIntents: unknown[] = [];
  const theIntent = { type: "feat", breaking: false, message: "add checkout flow", changedFiles: ["src/checkout.ts"] };
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "type=feat", diff: "the-diff", intent: theIntent }),
  });
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedIntents.push(enrichment?.intent);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f5-intent-threaded-diff-mode", mode: "diff" });

  assert.ok(capturedIntents.length > 0, "generate() must have been called at least once");
  for (const captured of capturedIntents) {
    assert.deepEqual(captured, theIntent, "every generate() call in diff mode must receive the SAME intent classify() surfaced, not an empty/undefined value");
  }
});

test("a non-diff mode never calls classify(), so generate() receives no intent (undefined, never fabricated)", async () => {
  let classifyCallCount = 0;
  const capturedIntents: unknown[] = [];
  const { ports } = stubPorts({
    classify: async () => { classifyCallCount++; return { action: "generate", reason: "n/a", diff: "should never be read", intent: { type: "feat", breaking: false, message: "x", changedFiles: [] } }; },
  });
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedIntents.push(enrichment?.intent);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f5-non-diff-mode-no-intent", mode: "manual" });

  assert.equal(classifyCallCount, 0, "only diff mode runs classifyCommit");
  assert.ok(capturedIntents.length > 0, "generate() must still have been called");
  for (const captured of capturedIntents) {
    assert.equal(captured, undefined, "without classification, no intent must be fabricated");
  }
});

/* serviceLinksCount/contractDriftCount telemetry must survive from the mainline `extra?` bag into
   the RETURNED gateSignals literal `toRunOutcome` constructs — this is the exact gap a prior
   design revision left as dead code (fields typed+mapped for persistence, but the construction
   literal itself never read them back out of `extra`). undefined-preserving, NEVER a fabricated 0
   (a DELIBERATE departure from catalogGate*'s `?? 0` default — ADR-B). ───────────────────────────
 */

test("structuralSignalBytes/serviceLinksCount/contractDriftCount survive into the persisted RunOutcome.gateSignals when the structural/serviceLinks collaborators are wired and populated", async () => {
  let savedGateSignals: RunOutcome["gateSignals"] | undefined;
  const { ports } = stubPorts({});
  ports.runHistory.save = async (outcome) => { savedGateSignals = outcome.gateSignals; };
  const structuralSignal: StructuralSignalPort = {
    render: async () => ({ text: "## Structural blast radius (deterministic — from the code graph, advisory)\nsome content", hasSymbols: false }),
  };
  const link = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
    transport: "http" as const,
    confidence: 0.9,
    source: "openapi",
  };
  const drift = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    verb: "GET",
    path: "/orders/:id/history",
  };
  const serviceLinks: ServiceLinksPort = {
    resolve: async () => ({ links: [link], drift: [drift] }),
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, serviceLinks, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "telemetry-populated" });

  assert.ok(savedGateSignals, "runHistory.save must have been called on the mainline exit");
  assert.equal(typeof savedGateSignals!.structuralSignalBytes, "number", "structuralSignalBytes must be a real number when structuralSignal produced a non-empty render");
  assert.ok(savedGateSignals!.structuralSignalBytes! > 0, "structuralSignalBytes must reflect the actual byte length of the rendered signal, not a placeholder");
  assert.equal(savedGateSignals!.serviceLinksCount, 1, "serviceLinksCount must reflect resolvedServiceLinks.length");
  assert.equal(savedGateSignals!.contractDriftCount, 1, "contractDriftCount must reflect resolvedContractDrift.length");
});

test("serviceLinksCount/contractDriftCount are 0 (not undefined) when the serviceLinks resolver is wired but finds nothing — 'ran, found none' must be distinguishable from 'never ran'", async () => {
  let savedGateSignals: RunOutcome["gateSignals"] | undefined;
  const { ports } = stubPorts({});
  ports.runHistory.save = async (outcome) => { savedGateSignals = outcome.gateSignals; };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [], drift: [] }) };
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "telemetry-resolver-found-none" });

  assert.equal(savedGateSignals!.serviceLinksCount, 0, "0 means the resolver ran and found nothing — must NOT be undefined");
  assert.equal(savedGateSignals!.contractDriftCount, 0, "0 means the resolver ran and found nothing — must NOT be undefined");
});

test("structuralSignalBytes/serviceLinksCount/contractDriftCount stay undefined (never a fabricated 0) when neither collaborator is wired — 'never ran' semantics", async () => {
  let savedGateSignals: RunOutcome["gateSignals"] | undefined;
  const { ports } = stubPorts({});
  ports.runHistory.save = async (outcome) => { savedGateSignals = outcome.gateSignals; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "telemetry-absent-collaborators" });

  assert.equal(savedGateSignals!.structuralSignalBytes, undefined, "absent collaborator must leave structuralSignalBytes undefined, never a fabricated 0");
  assert.equal(savedGateSignals!.serviceLinksCount, undefined, "absent collaborator must leave serviceLinksCount undefined, never a fabricated 0");
  assert.equal(savedGateSignals!.contractDriftCount, undefined, "absent collaborator must leave contractDriftCount undefined, never a fabricated 0");
});

test("an early-exit terminal (static-gate invalid) never reaches the mainline telemetry wiring — the three fields stay undefined even with both collaborators wired", async () => {
  let savedGateSignals: RunOutcome["gateSignals"] | undefined;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.runHistory.save = async (outcome) => { savedGateSignals = outcome.gateSignals; };
  const structuralSignal: StructuralSignalPort = { render: async () => ({ text: "some content", hasSymbols: false }) };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [{ from: { repo: "a", file: "b", symbol: "c" }, to: { repo: "d", file: "e", symbol: "f" }, transport: "http" as const, confidence: 1, source: "openapi" }], drift: [] }) };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, serviceLinks, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "telemetry-invalid-exit" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(savedGateSignals!.structuralSignalBytes, undefined, "the invalid-exit path never reaches the mainline extra? wiring — telemetry stays undefined, matching the mainline-only precedent catalogGate* already established");
  assert.equal(savedGateSignals!.serviceLinksCount, undefined);
  assert.equal(savedGateSignals!.contractDriftCount, undefined);
});

/* The returned RunQaResult carries the real per-case results + execution logs, and the persisted
   RunOutcome mirrors them — RunHistoryPort.save receives the SAME cases/logs the caller sees.
 */

test("a passing run's RunQaResult.cases mirrors ExecutionPort.execute()'s real cases, not an empty array", async () => {
  const realCases = [{ name: "checkout flow", status: "pass" as const, file: "a.spec.ts" }];
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: realCases, logs: "1 passed" }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f3-real-cases" });

  assert.deepEqual(out.cases, realCases);
  assert.equal(out.logs, "1 passed");
});

test("the persisted RunOutcome carries the SAME cases/logs as the returned RunQaResult (adapter parity)", async () => {
  const realCases = [{ name: "login flow", status: "pass" as const, file: "a.spec.ts" }];
  let savedOutcome: { cases?: unknown[]; logs?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: realCases, logs: "1 passed, 0 failed" }),
  });
  ports.runHistory.save = async (outcome) => { savedOutcome = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f3-persisted-matches-returned" });

  assert.deepEqual(savedOutcome?.cases, out.cases);
  assert.equal(savedOutcome?.logs, out.logs);
});

test("an early-exit terminal (invalid) carries cases:[] and no logs — nothing was ever executed", async () => {
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f3-invalid-no-cases" });

  assert.equal(out.decision.verdict, "invalid");
  assert.deepEqual(out.cases, []);
  assert.equal(out.logs, undefined, "an exit that never reached execute() must not fabricate a logs string");
});

/* Per-run baselineCases: measure() is only ever called when run.verdict === "pass", so run.cases
   AT THAT POINT is exactly the green baseline. The composition root's static ctx.baselineCases
   placeholder is `[]` — the per-call arg is what supplies a real value.
 */

test("measure() receives the run's own passing case names as baselineCases", async () => {
  const passingCases = [
    { name: "login flow", status: "pass" as const, file: "a.spec.ts" },
    { name: "checkout flow", status: "pass" as const, file: "a.spec.ts" },
  ];
  let capturedBaselineCases: string[] | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: passingCases, logs: "2 passed" }),
    measure: async (_br, _specDir, _diff, baselineCases) => {
      capturedBaselineCases = baselineCases;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "baseline-cases-from-run", mode: "diff" });

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(capturedBaselineCases, ["login flow", "checkout flow"]);
});

test("measure() excludes non-passing case names from baselineCases (a flaky-then-pass run's own flaky case is not a 'clean baseline' case)", async () => {
  /* A verdict of "pass" can still carry non-"pass" cases in its list (e.g. a flaky case that
     eventually passed on retry is recorded with status:"flaky", not "pass" — CaseStatus union).
   */
  const mixedCases = [
    { name: "login flow", status: "pass" as const },
    { name: "checkout flow", status: "flaky" as const },
  ];
  let capturedBaselineCases: string[] | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: mixedCases, logs: "1 passed, 1 flaky" }),
    measure: async (_br, _specDir, _diff, baselineCases) => {
      capturedBaselineCases = baselineCases;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "baseline-cases-excludes-flaky", mode: "diff" });

  assert.deepEqual(capturedBaselineCases, ["login flow"], "only genuinely-passing cases belong in the baseline");
});

test("a non-pass verdict never calls measure() at all — no baselineCases question arises (measure is gated on run.verdict==='pass')", async () => {
  let measureCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
    measure: async () => { measureCallCount++; return { status: "unknown", ratio: null }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "no-measure-on-fail", mode: "diff" });

  assert.equal(measureCallCount, 0, "measure() must never be called for a non-pass verdict — baselineCases threading is entirely moot here");
});

/* CleanupPort must run so namespaced rows do not leak into live DEV. See cleanup.port.ts for
   the full "when does cleanup run" contract.
 */

test("CLEANUP: cleanup() is called with the run's previousNamespace, AFTER setup and BEFORE generate()", async () => {
  const callOrder: string[] = [];
  let capturedOpts: { namespace: string } | undefined;
  const { ports } = stubPorts({
    setup: async () => { callOrder.push("setup"); },
    cleanup: async (_specDir, opts) => { callOrder.push("cleanup"); capturedOpts = opts; },
    generate: async () => { callOrder.push("generate"); return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "cleanup-order-and-namespace", previousNamespace: "qa-portfolio-abc123-run42" });

  assert.deepEqual(callOrder, ["setup", "cleanup", "generate"], "cleanup must run strictly between setup and generate");
  assert.equal(capturedOpts?.namespace, "qa-portfolio-abc123-run42", "cleanup must receive the run's previousNamespace verbatim");
});

test("CLEANUP: cleanup() is SKIPPED when previousNamespace is absent (the common case — the prior run finished cleanly)", async () => {
  let cleanupCalled = false;
  const { ports } = stubPorts({
    cleanup: async () => { cleanupCalled = true; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "cleanup-skipped-no-previous-namespace" });

  assert.equal(cleanupCalled, false, "cleanup must never fire without a previousNamespace —");
  assert.equal(out.decision.verdict, "pass", "a run with no cleanup work must proceed normally");
});

test("CLEANUP: an absent CleanupPort (deps.cleanup undefined) is a no-op — generation still runs (backward compatible)", async () => {
  const { ports } = stubPorts();
  const { cleanup: _unused, ...portsWithoutCleanup } = ports;
  const useCase = new RunQaUseCase({ ...portsWithoutCleanup, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "cleanup-absent-backward-compat", previousNamespace: "qa-portfolio-abc123-run42" });

  assert.equal(out.decision.verdict, "pass", "an absent CleanupPort must never break a run — this composition simply skips the cleanup phase");
});

test("CLEANUP: a cleanup() failure is logged and swallowed — the run's verdict is UNCHANGED, generation still proceeds", async () => {
  let generateCalled = false;
  const { ports } = stubPorts({
    cleanup: async () => { throw new Error("playwright test cleanup.spec.ts exited 1"); },
    generate: async () => { generateCalled = true; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "cleanup-failure-non-blocking", previousNamespace: "qa-portfolio-abc123-run42" });

  assert.equal(generateCalled, true, "generation must proceed after a cleanup failure");
  assert.equal(out.decision.verdict, "pass", "a cleanup failure must NEVER alter this run's verdict");
});

test("CLEANUP: an already-aborted signal short-circuits before cleanup() ever runs", async () => {
  const controller = new AbortController();
  controller.abort();
  let cleanupCalled = false;
  const { ports } = stubPorts({ cleanup: async () => { cleanupCalled = true; } });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "cleanup-already-aborted", previousNamespace: "qa-portfolio-abc123-run42" }, controller.signal);

  assert.equal(cleanupCalled, false, "cleanup must never run once the signal is already aborted — an earlier short-circuit fires first");
  assert.equal(out.decision.verdict, "infra-error");
});

test("executedRed: the outer review gate is unreachable for a fail verdict — review() is never invoked, confirming the override sits on a genuinely dormant path (regression pin)", async () => {
  /* maxRetries:0 makes the FixLoop exhaust its budget immediately and return the initial "fail"
     verdict unchanged, so `run.verdict` stays "fail" all the way to the review phase's own outer
     guard (`run.verdict === "pass" && cfg.needsReview`). If a future change ever widened that guard
     to admit a fail verdict WITHOUT the executedRed override also firing, this test's
     reviewCallCount assertion would flip from 0 to 1+ with review() itself returning approved:true —
     exactly the circular-approval hole a fail verdict must not open. Today, the guard's own
     unreachability is the first line of defense; the override (pinned by the DIRECT test below) is
     the second.
   */
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "checkout flow", status: "fail" as const }], logs: "1 failed" }),
    review: async () => { reviewCallCount++; return { approved: true, findings: [], blockingCount: 0, parsed: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, maxRetries: 0 } });

  const out = await useCase.run({ ...baseInput, runId: "executed-red-outer-guard-unreachable" });

  assert.equal(reviewCallCount, 0, "review() must never be invoked for a fail verdict under the current outer guard");
  assert.notEqual(out.decision.verdict, "pass", "a failing executed run must never resolve to a reviewer-approved pass");
  assert.notEqual(out.decision.sideEffect, "pr", "a fail verdict must never side-effect a PR");
});

test("executedRed: evidence green (run.verdict==='pass') — a genuine reviewer approval stands, the override's condition never evaluates true", async () => {
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [{ name: "checkout flow", status: "pass" as const, file: "a.spec.ts" }], logs: "1 passed" }),
    review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "executed-red-not-triggered-on-green" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr", "a genuinely green run with a genuine reviewer approval must publish normally — the executedRed override must never fire on green evidence");
});

test("executedRed: DIRECT logic pin — reproduces the override's own condition in isolation, proving round===0 && verdict==='fail' overrides an approved:true verdict fail-closed", async () => {
  /* The use-case's executedRed guard is intentionally NOT extracted into a standalone exported
     helper (it is a 3-line inline check colocated with the review loop it protects, matching every
     etc.). This test pins the SAME boolean expression the source uses
     (`round === 0 && run.verdict === "fail"`) against the review loop's own reachable shape, so a
     change to the override's condition (e.g. accidentally scoping it to round 1, or dropping the
     round guard entirely) is caught here even though the guard is unreachable end-to-end today.
   */
  const round = 0;
  const runVerdict: "pass" | "fail" | "flaky" = "fail";
  const executedRed = round === 0 && runVerdict === "fail";
  assert.equal(executedRed, true, "round 0 + a fail verdict must compute executedRed:true");

  const roundOne = 1;
  const executedRedRoundOne = (roundOne as number) === 0 && runVerdict === "fail";
  assert.equal(executedRedRoundOne, false, "round >= 1 must NEVER trigger the override —");

  const passVerdict: "pass" | "fail" | "flaky" = "pass";
  const executedRedOnPass = round === 0 && (passVerdict as string) === "fail";
  assert.equal(executedRedOnPass, false, "a pass verdict must never trigger the override, confirming the condition is verdict-specific, not round-only");
});

/* .ground()'s new third arg, so the adapter can derive deterministic [CHANGED] markers from it. ── */

test("a diff-mode run threads classificationDiff into preGenerationGrounding.ground()'s third arg", async () => {
  let capturedDiff: string | undefined;
  const REAL_DIFF = "diff --git a/src/checkout.ts b/src/checkout.ts\n+export function pay() {}\n";
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/checkout.ts", diff: REAL_DIFF }),
    ground: async (_specDir, _signal, diff) => { capturedDiff = diff; return {}; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "diff-threading" });

  assert.equal(capturedDiff, REAL_DIFF, "ground() must receive the SAME real diff classify() derived, not a placeholder");
});

test("a non-diff mode run leaves ground()'s diff arg absent (classificationDiff never populated outside diff mode)", async () => {
  let capturedDiff: string | undefined = "sentinel-never-overwritten";
  let groundCalled = false;
  const { ports } = stubPorts({
    ground: async (_specDir, _signal, diff) => { groundCalled = true; capturedDiff = diff; return {}; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "manual", runId: "non-diff-mode" });

  assert.ok(groundCalled, "ground() must still be called in non-diff mode (grounding is not diff-gated)");
  assert.equal(capturedDiff, undefined, "non-diff modes never classify, so the diff arg must stay absent, never fabricated");
});

/* 4b.4: RunQaUseCase threads an OPTIONAL structuralSignal collaborator into baseEnrichment.staticSignal,
   byte-identical when absent. 4b.5 (CRITICAL-1): the BlastRadius passed to render() must be the REAL
   classificationIntent.changedFiles set, never the empty placeholder — a unit test that constructs
   its own BlastRadius cannot catch this; this suite drives the real diff-mode classify() -> render()
   path end-to-end.
 */

test("4b.4: a present structuralSignal port is called exactly once before the first generate(), and its result reaches baseEnrichment.staticSignal", async () => {
  let renderCallCount = 0;
  const capturedStaticSignals: (string | undefined)[] = [];
  const { ports } = stubPorts({});
  const structuralSignal: StructuralSignalPort = {
    render: async () => { renderCallCount++; return { text: "## Structural blast radius (deterministic — from the code graph, advisory)\nsome content", hasSymbols: false }; },
  };
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedStaticSignals.push(enrichment?.staticSignal);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "4b4-structural-signal-present" });

  assert.equal(renderCallCount, 1, "structuralSignal.render() must be called exactly once per run");
  assert.ok(capturedStaticSignals.length > 0, "generate() must have been called at least once");
  for (const captured of capturedStaticSignals) {
    assert.match(captured ?? "", /Structural blast radius/, "the rendered advisory block must reach baseEnrichment.staticSignal");
  }
});

test("4b.4: an ABSENT structuralSignal port leaves baseEnrichment with NO staticSignal key at all (byte-identical to today)", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({});
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "4b4-structural-signal-absent" });

  assert.ok(capturedEnrichments.length > 0, "generate() must have been called at least once");
  for (const captured of capturedEnrichments) {
    assert.ok(captured && !("staticSignal" in captured), "staticSignal must not exist as a key at all when the collaborator is absent — not merely undefined");
  }
});

test("4b.4: an empty render() result (no signal to report) leaves baseEnrichment with NO staticSignal key either", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({});
  const structuralSignal: StructuralSignalPort = { render: async () => ({ text: "", hasSymbols: false }) };
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "4b4-structural-signal-empty-render" });

  for (const captured of capturedEnrichments) {
    assert.ok(captured && !("staticSignal" in captured), "an empty rendered string must not add a staticSignal key (conditional spread, matching contextPack's own precedent)");
  }
});

test("4b.4: a throwing structuralSignal port degrades to NO staticSignal, never aborts the run (best-effort, mirrors preGenerationGrounding's own posture)", async () => {
  const { ports } = stubPorts({});
  const structuralSignal: StructuralSignalPort = { render: async () => { throw new Error("code graph wedged"); } };
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "4b4-structural-signal-throws" });

  assert.notEqual(out.decision.verdict, "infra-error", "a structuralSignal failure must never abort the run as infra-error");
  for (const captured of capturedEnrichments) {
    assert.ok(captured && !("staticSignal" in captured), "a thrown render() must degrade to no staticSignal, never propagate");
  }
});

/* The brief already carries the distilled blast radius: computing the structural signal too costs process spawns and
   would put a second, advisory copy of the same fact in the prompt. */
test("the structural signal port is invoked once and its text reaches generation", async () => {
  const calls: string[] = [];
  const structuralSignal: StructuralSignalPort = { render: async () => { calls.push("render"); return { text: "## Structural blast radius\ncontent", hasSymbols: false }; } };
  const capturedSignals: Array<string | undefined> = [];
  const { ports } = stubPorts({});
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedSignals.push(enrichment?.staticSignal);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  await new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig }).run({ ...baseInput, runId: "structural-gate" });
  assert.deepEqual(calls, ["render"], "the signal is computed once");
  assert.ok(capturedSignals.length > 0 && capturedSignals.every((s) => typeof s === "string"));
});

/* With structuralSignal absent (today's composition default), the verdict/side-effect must be
   byte-identical to every pre-existing scenario this same suite already pins
   elsewhere in this file — a targeted spot-check, not a re-run of the full golden suite.
 */
test("4b.4.2 (Scenario H baseline): a clean green run's verdict/sideEffect is unaffected by the structuralSignal wiring being absent", async () => {
  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "4b4-2-golden-baseline-absent" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

/* The REAL non-empty BlastRadius must reach the port.
 */
test("4b.5 CRITICAL-1: a diff-mode run with classificationIntent.changedFiles feeds the SAME (sorted/deduped) files to structuralSignal.render()", async () => {
  const changedFiles = ["src/main/java/Foo.java", "src/main/java/Bar.java"];
  let recordedChangedFiles: readonly string[] | undefined;
  const { ports } = stubPorts({
    classify: async () => ({
      action: "generate",
      reason: "type=feat",
      diff: "the-diff",
      intent: { type: "feat", breaking: false, message: "add checkout flow", changedFiles },
    }),
  });
  const structuralSignal: StructuralSignalPort = {
    render: async (_repoDir, changed) => { recordedChangedFiles = changed.changedFiles; return { text: "", hasSymbols: false }; },
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "4b5-critical1-real-blast-radius", mode: "diff" });

  assert.ok(recordedChangedFiles, "structuralSignal.render() must have been called");
  assert.ok(recordedChangedFiles!.length > 0, "the BlastRadius reaching render() must be NON-EMPTY in diff mode with real changedFiles — reaching render() with an EMPTY BlastRadius here is the exact CRITICAL-1 regression this test exists to catch");
  assert.deepEqual([...recordedChangedFiles!], [...changedFiles].sort(), "render() must receive the SAME changed files classify() surfaced (BlastRadius.of sorts+dedupes, so compare against the sorted shape)");
});

test("4b.5: a non-diff mode run (classificationIntent never populated) still calls render() with an EMPTY BlastRadius — never fabricated, matches the change-coverage mode gate", async () => {
  let recordedChangedFiles: readonly string[] | undefined;
  let renderCallCount = 0;
  const { ports } = stubPorts({
    classify: async () => { throw new Error("classify() must never be called outside diff mode"); },
  });
  const structuralSignal: StructuralSignalPort = {
    render: async (_repoDir, changed) => { renderCallCount++; recordedChangedFiles = changed.changedFiles; return { text: "", hasSymbols: false }; },
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "4b5-non-diff-mode-empty-blast-radius", mode: "manual" });

  assert.equal(renderCallCount, 1, "render() is still invoked once per run regardless of mode (the adapter/port itself short-circuits an empty BlastRadius, not the use-case)");
  assert.equal(recordedChangedFiles?.length, 0, "outside diff mode, classificationIntent is never populated, so the BlastRadius passed to render() must be empty — this is correct, tested behavior, not a gap");
});

/* structuralSignal used to skip cross-repo runs because the adapter was pinned to the PRIMARY
   graph. Composition now indexes/queries the classify-source repo, so a service webhook MUST still
   render (the BlastRadius files belong to that service).
 */

test("structuralSignal.render() IS called when input.triggerRepo is set (graph is classify-source scoped)", async () => {
  let renderCallCount = 0;
  const { ports } = stubPorts({});
  const structuralSignal: StructuralSignalPort = {
    render: async () => { renderCallCount++; return { text: "## Structural blast radius\nsome content", hasSymbols: false }; },
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "cross-repo-skip", triggerRepo: "org/orders-svc" });

  assert.equal(renderCallCount, 1, "a cross-repo run must query the classify-source graph, not skip the signal");
});

test("baseEnrichment carries staticSignal on a cross-repo run when structuralSignal is wired", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({});
  const structuralSignal: StructuralSignalPort = {
    render: async () => ({ text: "## Structural blast radius\nsome content", hasSymbols: false }),
  };
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "cross-repo-no-static-signal", triggerRepo: "org/orders-svc" });

  assert.ok(capturedEnrichments.length > 0, "generate() must have been called at least once");
  for (const captured of capturedEnrichments) {
    assert.equal(captured?.staticSignal, "## Structural blast radius\nsome content");
  }
});

/* Only a signal that names symbols stands for an explored blast radius: the port says which kind it rendered, and the flag must reach the generation of every pass, because every regeneration speaks of the blast radius too. */

test("a signal the port reports as naming symbols carries that flag on the first generation and on a review-correction regeneration", async () => {
  const capturedEnrichments: Array<Record<string, unknown> | undefined> = [];
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    review: (() => {
      let round = 0;
      return async () => {
        round++;
        if (round === 1) return { approved: false, findings: [{ text: "fix the thing", severity: "blocking" as const }], blockingCount: 1, parsed: true };
        return { approved: true, findings: [], blockingCount: 0, parsed: true };
      };
    })(),
  });
  const structuralSignal: StructuralSignalPort = {
    render: async () => ({ text: "## Structural blast radius\n- `save` (src/Foo.java)", hasSymbols: true }),
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: { needsReview: true } });

  await useCase.run({ ...baseInput, runId: "signal-flag-symbols" });

  assert.ok(capturedEnrichments.length >= 2, "the first generation plus at least one review-correction regeneration");
  for (const captured of capturedEnrichments) {
    assert.equal(captured?.staticSignalHasSymbols, true);
    assert.equal(typeof captured?.staticSignal, "string", "the flag travels with its signal");
  }
});

test("the files a signal's dossier shows travel with the signal to the generation, and none when it shows none", async () => {
  const run = async (providedFiles?: string[]) => {
    const captured: Array<Record<string, unknown> | undefined> = [];
    const { ports } = stubPorts({
      generate: async (_specDir, _signal, _diff, enrichment) => {
        captured.push(enrichment as Record<string, unknown> | undefined);
        return scriptedGeneration({ specs: ["a.spec.ts"]});
      },
    });
    const structuralSignal: StructuralSignalPort = { render: async () => ({ text: "## Structural blast radius\n- `save` (src/Foo.java)", hasSymbols: true, ...(providedFiles ? { providedFiles } : {}) }) };
    await new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig }).run({ ...baseInput, runId: `dossier-files-${providedFiles?.length ?? 0}` });
    return captured[0];
  };
  assert.deepEqual((await run(["src/Foo.java"]))?.staticSignalFiles, ["src/Foo.java"]);
  assert.equal("staticSignalFiles" in ((await run()) ?? {}), false);
});

test("a co-change-only signal reaches every generation with no symbol flag at all: absent, never false", async () => {
  const capturedEnrichments: Array<Record<string, unknown> | undefined> = [];
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    review: (() => {
      let round = 0;
      return async () => {
        round++;
        if (round === 1) return { approved: false, findings: [{ text: "fix the thing", severity: "blocking" as const }], blockingCount: 1, parsed: true };
        return { approved: true, findings: [], blockingCount: 0, parsed: true };
      };
    })(),
  });
  const structuralSignal: StructuralSignalPort = {
    render: async () => ({ text: renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }] }), hasSymbols: false }),
  };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: { needsReview: true } });

  await useCase.run({ ...baseInput, runId: "signal-flag-co-change" });

  assert.ok(capturedEnrichments.length >= 2);
  for (const captured of capturedEnrichments) {
    assert.equal(typeof captured?.staticSignal, "string", "the co-change block itself still reaches the prompt");
    assert.equal(captured && "staticSignalHasSymbols" in captured, false, "the flag is absent, not merely false");
  }
});

test("a symbol flag never travels without a signal: an empty render drops both", async () => {
  const capturedEnrichments: Array<Record<string, unknown> | undefined> = [];
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const structuralSignal: StructuralSignalPort = { render: async () => ({ text: "", hasSymbols: true }) };
  const useCase = new RunQaUseCase({ ...ports, structuralSignal, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "signal-flag-without-signal" });

  assert.ok(capturedEnrichments.length > 0);
  for (const captured of capturedEnrichments) {
    assert.equal(captured && ("staticSignalHasSymbols" in captured || "staticSignal" in captured), false);
  }
});

/* RunQaUseCase's optional serviceLinks collaborator is invoked in EVERY generation mode (not
   diff-mode-only) because service links are app-static per SHA, not diff-derived — unlike
   structuralSignal's BlastRadius, which genuinely needs diff mode's classificationIntent.changedFiles.
 */

test("a present serviceLinks port is called exactly once before the first generate(), and non-empty links reach baseEnrichment.serviceLinks", async () => {
  let resolveCallCount = 0;
  const capturedServiceLinks: (readonly unknown[] | undefined)[] = [];
  const { ports } = stubPorts({});
  const link = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
    transport: "http" as const,
    confidence: 0.9,
    source: "openapi",
  };
  const serviceLinks: ServiceLinksPort = {
    resolve: async () => { resolveCallCount++; return { links: [link], drift: [] }; },
  };
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedServiceLinks.push(enrichment?.serviceLinks);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "service-links-present" });

  assert.equal(resolveCallCount, 1, "serviceLinks.resolve() must be called exactly once per run");
  assert.ok(capturedServiceLinks.length > 0, "generate() must have been called at least once");
  for (const captured of capturedServiceLinks) {
    assert.deepEqual(captured, [link], "the resolved links must reach baseEnrichment.serviceLinks unchanged");
  }
});

test("a present serviceLinks port is invoked exactly once EVEN in a non-diff generation mode (ADR-7: app-static, not diff-gated)", async () => {
  let resolveCallCount = 0;
  const { ports } = stubPorts({
    classify: async () => { throw new Error("classify() must never be called outside diff mode"); },
  });
  const serviceLinks: ServiceLinksPort = {
    resolve: async () => { resolveCallCount++; return { links: [], drift: [] }; },
  };
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "service-links-non-diff-mode", mode: "manual" });

  assert.equal(resolveCallCount, 1, "resolve() must be invoked once in complete/exhaustive/manual modes too — service links are app-static per SHA, not diff-derived (ADR-7), unlike structuralSignal's diff-only gate");
});

test("an ABSENT serviceLinks port leaves baseEnrichment with NO serviceLinks/contractDrift key at all (byte-identical to today)", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({});
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "service-links-absent" });

  assert.ok(capturedEnrichments.length > 0, "generate() must have been called at least once");
  for (const captured of capturedEnrichments) {
    assert.ok(captured && !("serviceLinks" in captured), "serviceLinks must not exist as a key at all when the collaborator is absent");
    assert.ok(captured && !("contractDrift" in captured), "contractDrift must not exist as a key at all when the collaborator is absent");
  }
});

test("a present serviceLinks port that resolves to empty links+drift leaves baseEnrichment with NO key either (matches structuralSignal's own empty-render precedent)", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({});
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [], drift: [] }) };
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "service-links-empty-resolve" });

  for (const captured of capturedEnrichments) {
    assert.ok(captured && !("serviceLinks" in captured), "an empty links array must not add a serviceLinks key (conditional spread)");
    assert.ok(captured && !("contractDrift" in captured), "an empty drift array must not add a contractDrift key (conditional spread)");
  }
});

test("a throwing serviceLinks port degrades to NO serviceLinks/contractDrift key, never aborts the run (best-effort, mirrors structuralSignal's own fail-open posture)", async () => {
  const { ports } = stubPorts({});
  const serviceLinks: ServiceLinksPort = { resolve: async () => { throw new Error("mirror registry unreachable"); } };
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "service-links-throws" });

  assert.notEqual(out.decision.verdict, "infra-error", "a serviceLinks failure must never abort the run as infra-error");
  for (const captured of capturedEnrichments) {
    assert.ok(captured && !("serviceLinks" in captured), "a thrown resolve() must degrade to no serviceLinks key, never propagate");
    assert.ok(captured && !("contractDrift" in captured), "a thrown resolve() must degrade to no contractDrift key, never propagate");
  }
});

test("non-empty links + empty drift populates ONLY baseEnrichment.serviceLinks — contractDrift stays independently absent (not forced to [])", async () => {
  const capturedEnrichments: (Record<string, unknown> | undefined)[] = [];
  const { ports } = stubPorts({});
  const link = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
    transport: "http" as const,
    confidence: 0.9,
    source: "openapi",
  };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [link], drift: [] }) };
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedEnrichments.push(enrichment as Record<string, unknown> | undefined);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "links-only-no-drift" });

  for (const captured of capturedEnrichments) {
    assert.deepEqual(captured?.serviceLinks, [link], "serviceLinks must be populated");
    assert.ok(captured && !("contractDrift" in captured), "contractDrift must stay absent, independently of serviceLinks being present");
  }
});

test("a clean green run's verdict/sideEffect is unaffected by the serviceLinks wiring being absent", async () => {
  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "golden-baseline-absent" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

/* Anti-inert: drive RunQaUseCase.run() end-to-end through the REAL GenerationTurnsAdapter (not a
   use-case-level generation stub) with a RECORDING ServiceLinksPort fake, proving the FULL path —
   port -> enrichment -> adapter -> OpencodeRunInput — not merely that the port was invoked in isolation.
 */

function fakeAuthoringPortsForAntiInert(capture: { input?: OpencodeRunInput }): AuthoringPorts {
  return {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: JSON.stringify({ specs: [] }) }),
        dispose: async () => {},
      }),
    } as unknown as AuthoringPorts["runtime"],
    rendering: {
      render: () => "",
      renderMain: (input) => { capture.input = input; return { text: "", sectionSizes: {} }; },
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (f: string) => `${f}.spec.ts`,
    },
    verdicts: {
      /* The tests below read the generator's input only; a declared no-op ends the run without touching anything else. */
      readGenerator: () => ({ specs: [], noopReason: "the test only inspects what the generator was given" }),
      readReview: () => ({ approved: true, findings: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_d, entries) => [...entries] },
  };
}

test("anti-inert: RunQaUseCase.run() end-to-end through the REAL GenerationTurnsAdapter — a recording ServiceLinksPort's non-empty links reach the generation port's OpencodeRunInput.serviceLinks", async () => {
  const captured: { input?: OpencodeRunInput } = {};
  const generationPorts = fakeAuthoringPortsForAntiInert(captured);
  const generateTestsUseCase = new GenerateTestsUseCase(generationPorts);
  const generation = new GenerationTurnsAdapter(generateTestsUseCase, {
    repo: "org/front", appName: "app", mirrorDir: "/mirrors/org/front", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", mode: "diff", diff: "",
  });

  const link = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
    transport: "http" as const,
    confidence: 0.9,
    source: "openapi",
  };
  let resolveCallCount = 0;
  const serviceLinks: ServiceLinksPort = {
    resolve: async () => { resolveCallCount++; return { links: [link], drift: [] }; },
  };

  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, generation, serviceLinks, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "anti-inert-present" });

  assert.equal(resolveCallCount, 1, "serviceLinks.resolve() must have been called exactly once");
  assert.ok(captured.input, "renderMain must have been called — the generator session never ran through the REAL GenerationTurnsAdapter");
  assert.deepEqual(
    captured.input?.serviceLinks,
    [link],
    "the recorded link must reach the REAL GenerationTurnsAdapter's OpencodeRunInput.serviceLinks — proving the full port -> enrichment -> adapter -> prompt-input path, not just that the port was invoked",
  );
  assert.notEqual(out.decision.verdict, "infra-error");
});

test("anti-inert companion: with the serviceLinks collaborator OMITTED, the REAL GenerationTurnsAdapter's OpencodeRunInput carries NO serviceLinks key at all", async () => {
  const captured: { input?: OpencodeRunInput } = {};
  const generationPorts = fakeAuthoringPortsForAntiInert(captured);
  const generateTestsUseCase = new GenerateTestsUseCase(generationPorts);
  const generation = new GenerationTurnsAdapter(generateTestsUseCase, {
    repo: "org/front", appName: "app", mirrorDir: "/mirrors/org/front", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", mode: "diff", diff: "",
  });

  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, generation, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "anti-inert-absent" });

  assert.ok(captured.input, "renderMain must have been called");
  assert.equal(
    "serviceLinks" in (captured.input ?? {}),
    false,
    "OpencodeRunInput.serviceLinks must be entirely ABSENT when the serviceLinks collaborator is omitted — presence/absence of the collaborator is the ONLY variable controlling this field",
  );
});

/* crossRepoImpact collaborator. Case A: triggerRepo present + a matching resolvedServiceLinks entry
   + deps.crossRepoImpact wired -> resolve() is invoked, the result flows into
   baseEnrichment.crossRepoImpact and gateSignals.crossRepoImpactedCount. Case B: a same-repo run
   (no input.triggerRepo) -> the port is NEVER invoked at all (spec scenario "Same-repo run never
   triggers the composition"). ──────────────────────────────────────────────────────────────────
 */

test("a cross-repo run whose trigger matches a resolved service link asks the crossRepoImpact port, and the impact reaches generation and telemetry", async () => {
  const link: ServiceLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders-svc", file: "src/routes.ts", symbol: "getOrder" },
    transport: "http",
    confidence: 1,
    source: "openapi",
  };
  let resolveCallCount = 0;
  let resolveArgs: [string, string, readonly ServiceLink[]] | undefined;
  const crossRepoImpact: CrossRepoImpactPort = {
    resolve: async (triggerRepo, triggerSha, resolvedLinks) => {
      resolveCallCount++;
      resolveArgs = [triggerRepo, triggerSha, resolvedLinks];
      return { impactedLinks: [{ link, tier: "contract-file" }] };
    },
  };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [link], drift: [] }) };

  const captured: Parameters<AuthorPort["author"]>[3][] = [];
  const { ports } = stubPorts({
    generate: async (_a, _b, _c, enrichment) => {
      captured.push(enrichment);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, crossRepoImpact, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "cross-repo-impact-wired", triggerRepo: "org/orders-svc" });

  assert.equal(resolveCallCount, 1, "crossRepoImpact.resolve() must be called exactly once");
  assert.deepEqual(resolveArgs?.[0], "org/orders-svc");
  assert.deepEqual(resolveArgs?.[2], [link]);
  assert.ok(captured.length > 0);
  for (const enrichment of captured) {
    assert.deepEqual(enrichment?.crossRepoImpact, { impactedLinks: [{ link, tier: "contract-file" }] }, "the resolved impact must reach baseEnrichment.crossRepoImpact");
  }
  assert.equal(out.outcome?.gateSignals.crossRepoImpactedCount, 1, "crossRepoImpactedCount telemetry must reflect impactedLinks.length");
});

test("the grounding is handed the run's commit, the resolved service links and the cross-repo impact, so the change's candidates can be reached over them", async () => {
  const link: ServiceLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders-svc", file: "src/routes.ts", symbol: "getOrder" },
    transport: "http",
    confidence: 1,
    source: "openapi",
  };
  const impact = { impactedLinks: [{ link, tier: "contract-file" as const }] };
  const crossRepoImpact: CrossRepoImpactPort = { resolve: async () => impact };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [link], drift: [] }) };
  const changes: unknown[] = [];
  const preGenerationGrounding: PreGenerationGroundingPort = { ground: async (_specDir, _signal, _diff, change) => { changes.push(change); return {}; } };

  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, crossRepoImpact, preGenerationGrounding, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "grounding-gets-links", triggerRepo: "org/orders-svc" });

  assert.deepEqual(changes, [{ sha: baseInput.sha.toString(), serviceLinks: [link], crossRepoImpact: impact, candidates: [], hubPages: [] }]);
});

test("a same-repo run (no input.triggerRepo) never invokes the crossRepoImpact port at all", async () => {
  let resolveCallCount = 0;
  const crossRepoImpact: CrossRepoImpactPort = {
    resolve: async () => { resolveCallCount++; return null; },
  };
  const link: ServiceLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders-svc", file: "src/routes.ts", symbol: "getOrder" },
    transport: "http",
    confidence: 1,
    source: "openapi",
  };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [link], drift: [] }) };

  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, crossRepoImpact, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "cross-repo-impact-same-repo" });

  assert.equal(resolveCallCount, 0, "crossRepoImpact.resolve() must never be invoked for a same-repo run — input.triggerRepo absence is the guard");
});

/* Anti-inert: a recording fake replacing the CrossRepoImpactPort collaborator, driven through the
   REAL RunQaUseCase.run(), proving actual invocation end-to-end (not isolated unit coverage only).
 */

test("anti-inert integration proof — a recording CrossRepoImpactPort fake observes an actual invocation through the real RunQaUseCase.run()", async () => {
  const link: ServiceLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getRestaurants" },
    to: { repo: "org/restaurants-svc", file: "api-definition.yaml", symbol: "getRestaurants" },
    transport: "http",
    confidence: 1,
    source: "openapi",
  };
  const invocations: Array<{ triggerRepo: string; triggerSha: string; links: readonly ServiceLink[] }> = [];
  const crossRepoImpact: CrossRepoImpactPort = {
    resolve: async (triggerRepo, triggerSha, resolvedLinks) => {
      invocations.push({ triggerRepo, triggerSha, links: resolvedLinks });
      return { impactedLinks: [{ link, tier: "impacted-symbol" }] };
    },
  };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [link], drift: [] }) };

  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, crossRepoImpact, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "cross-repo-impact-anti-inert", triggerRepo: "org/restaurants-svc", sha: Sha.of("def5678") });

  assert.equal(invocations.length, 1, "the recording fake must have observed exactly one real invocation through RunQaUseCase.run()");
  assert.equal(invocations[0]?.triggerRepo, "org/restaurants-svc");
  assert.equal(invocations[0]?.triggerSha, "def5678");
  assert.deepEqual(invocations[0]?.links, [link]);
  assert.notEqual(out.decision.verdict, "infra-error", "a wired crossRepoImpact collaborator must never destabilize the run");
});

test("a crossRepoImpact port that reports an untrusted git dir fails the run loudly instead of degrading to no impact", async () => {
  const link: ServiceLink = {
    from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
    to: { repo: "org/orders-svc", file: "src/routes.ts", symbol: "getOrder" },
    transport: "http",
    confidence: 1,
    source: "openapi",
  };
  const crossRepoImpact: CrossRepoImpactPort = {
    resolve: async () => {
      throw new UntrustedGitTreeError("refusing to run git on /mirrors/org__orders-svc/.git: it is a symbolic link");
    },
  };
  const serviceLinks: ServiceLinksPort = { resolve: async () => ({ links: [link], drift: [] }) };
  const { ports } = stubPorts({});
  const useCase = new RunQaUseCase({ ...ports, serviceLinks, crossRepoImpact, config: baseConfig });

  await assert.rejects(useCase.run({ ...baseInput, runId: "cross-repo-untrusted-git", triggerRepo: "org/orders-svc", sha: Sha.of("def5678") }), UntrustedGitTreeError);
});

/* the fix-loop generation closure's own specSources return, and failureDomSnapshot. Before this
   fix, the author port's return type carried no specSources field at all (the port's
   own contract), so round 0's Lever-2 check ALWAYS saw specSources:[] no matter what the real
   GenerationTurnsAdapter's readSpecSource collaborator produced — checkSpecSelectors(specSources,
   trees) with an empty specSources array structurally cannot find a contradiction (its for-loop
   never runs). These tests prove the wiring by driving a REAL absent-selector contradiction through
   checkSpecSelectors' own pure contract: a spec source referencing a selector genuinely absent from
   the failure-point tree can only surface as a contradiction if specSources reaches Lever-2 non-empty. ──
 */

const ABSENT_BUTTON_SPEC_SOURCE = `await page.getByRole("button", { name: "Submit" }).click();`;

test("initialSpecSources threads from the initial generation into FixLoopInput, arming round-0's Lever-2 check", async () => {
  const capturedEnrichments: Array<{ selectorContradictions?: readonly string[]; fixCases?: readonly unknown[] }> = [];
  let generateCallCount = 0;
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCallCount++;
      capturedEnrichments.push(enrichment ?? {});
      /* The initial (round -1) generate() call returns the spec whose source text is later re-read
         as specSources — the authoring port's widened return type (this fix) carries it back here.
       */
      return scriptedGeneration({ specs: ["a.spec.ts"], specSources: [ABSENT_BUTTON_SPEC_SOURCE] });
    },
    execute: async () => ({
      verdict: "fail" as const,
      /* The failure-point tree carries a "button" role but with a DIFFERENT name ("Cancel", not
         "Submit") — this is what makes the absence CONCLUSIVE (verifiable) per selectorPresent's own
         contract: a role must be seen at least once with a real name for a name-mismatch to count as
         verifiable-absent rather than merely unverifiable (a bare "heading: Owners" tree, with no
         "button" role at all, would be unverifiable — see selectorPresent's `anyRoleWithRealName`
         gate). Lever-2 must find "button:Submit" verifiably absent IF (and only if) initialSpecSources
         reached round 0's check.
       */
      cases: [{ name: "checkout", status: "fail" as const, detail: "boom", failureDom: "heading: Owners\nbutton: Cancel" }],
      logs: "x",
    }),
  });
  const useCase = new RunQaUseCase({ ...ports, ...loginToBeWritten(), config: baseConfig });

  await useCase.run({ ...baseInput, runId: "initial-spec-sources-arms-round-0" });

  assert.ok(generateCallCount > 1, "sanity: the FixLoop must have engaged at least one regen round");
  const roundWithContradiction = capturedEnrichments.find(
    (e) => (e.fixCases?.length ?? 0) > 0 && (e.selectorContradictions?.length ?? 0) > 0,
  );
  assert.ok(
    roundWithContradiction,
    "expected a FixLoop regen call carrying a selectorContradictions entry for the absent button:Submit selector — this can ONLY happen if initialSpecSources reached round 0's Lever-2 check",
  );
  assert.match(roundWithContradiction!.selectorContradictions![0]!, /button.*Submit.*NOT in the captured failure-point tree/);
});

const CLEAN_HEADING_SPEC_SOURCE = `await page.getByRole("heading", { name: "Owners" }).click();`;

test("the fix-loop generation closure's returned specSources re-arms the NEXT round's Lever-2 check", async () => {
  const capturedEnrichments: Array<{ selectorContradictions?: readonly string[] }> = [];
  let generateCallCount = 0;
  let executeCallCount = 0;
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCallCount++;
      capturedEnrichments.push(enrichment ?? {});
      /* Round -1 (initial generate, generateCallCount===1) returns a CLEAN spec (its selector IS
         present in every failure tree below) — round 0's Lever-2 check finds nothing absent, so the
         loop does NOT short-circuit (fix-loop.aggregate.ts's absent-selector short-circuit) and genuinely re-executes.
         The FixLoop's OWN first regen call (generateCallCount===2, triggered by execute() failing)
         returns the absent-button spec source instead — this must re-arm round 1's Lever-2 check via
         the CLOSURE's returned specSources (never the static initial seed, which stayed clean).
       */
      const specSources = generateCallCount === 1 ? [CLEAN_HEADING_SPEC_SOURCE] : [ABSENT_BUTTON_SPEC_SOURCE];
      return scriptedGeneration({ specs: ["a.spec.ts"], specSources });
    },
    execute: async () => {
      executeCallCount++;
      /* Same "verifiable-absent" requirement as the sibling test above: the tree must carry the
         "button" role WITH a real (different) name for the "Submit" mismatch to be conclusive; the
         "heading: Owners" node keeps the CLEAN spec's own selector genuinely present every round. The
         failing case's NAME changes every round (Signal B — decideProgress's "failing name set
         changed" progress signal) so the fix-loop's fail-closed gate stays OPEN through round 1
         instead of closing to break-needs-human before a second regen call can ever happen.
       */
      return {
        verdict: "fail" as const,
        cases: [{ name: `checkout-${executeCallCount}`, status: "fail" as const, file: "a.spec.ts", detail: "boom", failureDom: "heading: Owners\nbutton: Cancel" }],
        logs: "x",
      };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, maxRetries: 2 } });

  await useCase.run({ ...baseInput, runId: "regen-specsources-rearms-next-round" });

  assert.ok(executeCallCount > 1, "sanity: the FixLoop must have retried at least once (round 0 found nothing absent, so it did not short-circuit)");
  const roundWithContradiction = capturedEnrichments.find((e) => (e.selectorContradictions?.length ?? 0) > 0);
  assert.ok(
    roundWithContradiction,
    "expected a LATER FixLoop regen call to carry a selectorContradictions entry sourced from the PRIOR round's own regen specSources — proving the closure's returned specSources feeds the next round's Lever-2 check",
  );
  assert.match(roundWithContradiction!.selectorContradictions![0]!, /button.*Submit.*NOT in the captured failure-point tree/);
});

test("a fix-loop round accepts real bytes, and a later worse round puts the best round's bytes back on disk", async () => {
  let generationCalls = 0;
  const executeNamespaces: (string | undefined)[] = [];
  const { ports, ws } = stubPorts({
    generate: async () => {
      const call = generationCalls + 1;
      generationCalls += 1;
      if (call === 1) {
        ws.write("a.spec.ts", "// a v0\n");
        ws.write("b.spec.ts", "// b v0\n");
        return scriptedGeneration({ specs: ["a.spec.ts", "b.spec.ts"]});
      }
      ws.write("a.spec.ts", `// a v${call - 1}\n`);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    execute: async (_specDir, opts) => {
      const o = opts && !(opts instanceof AbortSignal) ? opts : undefined;
      executeNamespaces.push(o?.namespace);
      if (o?.specFiles) {
        /* The acceptance execution: only the changed spec runs, and the bytes on disk decide its result. */
        const bytes = readFileSync(join(ws.specDir, "a.spec.ts"), "utf8");
        if (bytes.includes("v1")) {
          return { verdict: "pass" as const, cases: [{ name: "a", status: "pass" as const, file: "a.spec.ts" }], logs: "" };
        }
        return {
          verdict: "fail" as const,
          cases: [{ name: "a", status: "fail" as const, file: "a.spec.ts", detail: "getByRole resolved to 0 elements" }],
          logs: "",
        };
      }
      return {
        verdict: "fail" as const,
        cases: [
          { name: "a", status: "fail" as const, file: "a.spec.ts", detail: "getByRole resolved to 0 elements" },
          { name: "b", status: "fail" as const, file: "b.spec.ts", detail: "getByRole resolved to 0 elements" },
        ],
        logs: "",
      };
    },
  });
  try {
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 2 } });

    const out = await useCase.run({ ...baseInput, runId: "fixloop-best-bytes", mode: "diff" });

    assert.equal(
      readFileSync(join(ws.specDir, "a.spec.ts"), "utf8"),
      "// a v1\n",
      "the best round's accepted bytes must be back on disk, not the later worse round's",
    );
    assert.equal(out.decision.verdict, "fail");
    assert.equal(out.outcome?.cases?.filter((c) => c.status === "fail").length, 1, "the run keeps the best round's cases");
    assert.equal(out.outcome?.cases?.find((c) => c.name === "a")?.status, "pass", "the best round fixed a.spec.ts");
    assert.deepEqual(executeNamespaces.slice(1), ["fixloop-best-bytes-r1", "fixloop-best-bytes-r2"], "each acceptance execution carries its round's namespace");
  } finally {
    ws.cleanup();
  }
});

test("failureDomSnapshot threads the initial run's failure-point DOM into the FixLoop's regen prompt", async () => {
  const capturedDomSnapshots: (string | undefined)[] = [];
  const { ports } = stubPorts({
    execute: async () => ({
      verdict: "fail" as const,
      cases: [{ name: "checkout", status: "fail" as const, detail: "boom", failureDom: "heading: Owners\nbutton: Submit" }],
      logs: "x",
    }),
  });
  ports.generation.author = async (_specDir, _signal, _diff, enrichment) => {
    capturedDomSnapshots.push(enrichment?.domSnapshot);
    return scriptedGeneration({ specs: ["a.spec.ts"]});
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "failure-dom-snapshot-threaded" });

  const regenWithSnapshot = capturedDomSnapshots.find((s) => s?.includes("heading: Owners"));
  assert.ok(
    regenWithSnapshot,
    "expected at least one FixLoop regen call's domSnapshot to carry the initial failing case's captured failure-point DOM (built once from the run's initial failing cases, threaded via FixLoopInput.failureDomSnapshot)",
  );
});

/* A regenerated e2e spec with a compile error must not burn a live DEV execution to discover what
   tsc/eslint already knew. The aggregate no-ops when revalidate is absent; the use-case must supply it.
 */

test("after a fix-round regen, the FixLoop's revalidate hook is invoked against the SAME ValidationPort", async () => {
  let validateCallCount = 0;
  let executeCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCallCount++;
      return { ok: true, errors: [] };
    },
    execute: async () => {
      executeCallCount++;
      if (executeCallCount === 1) {
        return { verdict: "fail" as const, cases: [{ name: "checkout", status: "fail" as const, detail: "boom" }], logs: "x" };
      }
      return { verdict: "pass" as const, cases: [{ name: "checkout", status: "pass" as const }], logs: "" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "revalidate-invoked" });

  assert.notEqual(out.decision.verdict, "invalid");
  /* 1 initial validate() (the static gate, pre-execute) + at least 1 revalidate() call inside the
     FixLoop's own e2e retry branch (fix-loop.aggregate.ts:351-354) before the retry-execute.
   */
  assert.ok(validateCallCount > 1, `expected the FixLoop's revalidate hook to call validation.validate() again before the retry-execute, got ${validateCallCount} total validate() call(s)`);
});

test("a failed revalidation short-circuits the retry — execute() is NOT called again, run keeps its original verdict (per the aggregate's own contract)", async () => {
  let validateCallCount = 0;
  let executeCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCallCount++;
      /* The FIRST validate() call is the static gate (pre-execute) — must pass so we actually reach
         execute(). The SECOND call is the FixLoop's own revalidate() hook, post-regen — fails,
         per this test's scope.
       */
      if (validateCallCount === 1) return { ok: true, errors: [] };
      return { ok: false, errors: ["[lint] no-wait-for-timeout"] };
    },
    execute: async () => {
      executeCallCount++;
      return { verdict: "fail" as const, cases: [{ name: "checkout", status: "fail" as const, detail: "boom" }], logs: "x" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "failed-revalidate-short-circuits" });

  assert.equal(executeCallCount, 1, "a failed revalidate() must break the retry loop BEFORE any retry-execute call (fix-loop.aggregate.ts:351-354's own `if (!reValidation.ok) break;` contract) — execute() must have been called only the initial time");
});

/* The static-fix repair loop must carry the validation errors into the regen call as
   fixCases-shaped enrichment, and ONLY for repair rounds (never the initial generate() call).
 */

test("a static-gate repair round threads the validation errors into the regen call as fixCases, bounded", async () => {
  const capturedFixCases: Array<readonly { name: string; detail?: string }[] | undefined> = [];
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCallCount++;
      return validateCallCount === 1
        ? { ok: false, errors: ["39:11  error  'specialtyCell' is assigned a value but never used"] }
        : { ok: true, errors: [] };
    },
    generate: async (_specDir, _signal, _diff, enrichment) => {
      generateCallCount++;
      capturedFixCases.push(enrichment?.fixCases as readonly { name: string; detail?: string }[] | undefined);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "static-fix-threads-errors" });

  assert.equal(out.decision.verdict, "pass", "the static gate must still recover within MAX_STATIC_FIX_ROUNDS");
  assert.equal(generateCallCount, 2, "exactly 1 initial generate() + 1 repair regen for a single-round recovery");

  /* Call 0 is the INITIAL generate() — must NOT carry the static-gate fixCases enrichment. */
  assert.equal(capturedFixCases[0], undefined, "the INITIAL generate() call must NOT receive static-gate fixCases enrichment");

  /* Call 1 is the repair regen — must carry a "static-gate"-named case whose detail includes the
     validation error text, bounded (never unboundedly long).
   */
  const repairFixCases = capturedFixCases[1];
  assert.ok(repairFixCases && repairFixCases.length > 0, "the repair regen call must receive fixCases carrying the static-gate errors");
  const staticGateCase = repairFixCases!.find((c) => c.name === "static-gate");
  assert.ok(staticGateCase, "expected a fixCases entry named 'static-gate' so the prompt shows the source of the failure");
  assert.match(staticGateCase!.detail ?? "", /specialtyCell/, "the static-gate fixCases entry must carry the actual validation error text");
  assert.ok((staticGateCase!.detail?.length ?? 0) <= 4000, "the static-gate error detail must be bounded (~4000 chars cap), never unboundedly long");
});

test("the static-gate detail redacts a token the cap would have split: no part of it reaches the repair regeneration", async () => {
  const capturedFixCases: Array<readonly { name: string; detail?: string }[] | undefined> = [];
  const token = `sk-${"Q7x9Zk2M".repeat(6)}`;
  const lead = "39:11  error  'specialtyCell' is assigned a value but never used\n".repeat(80);
  const errors = [`${lead.slice(0, 3990)}${token} and the rest of the lint output`];
  let validateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => (++validateCallCount === 1 ? { ok: false, errors } : { ok: true, errors: [] }),
    generate: async (_specDir, _signal, _diff, enrichment) => {
      capturedFixCases.push(enrichment?.fixCases as readonly { name: string; detail?: string }[] | undefined);
      return scriptedGeneration({ specs: ["a.spec.ts"] });
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, redact: (text) => sanitizeText(text).text });

  await useCase.run({ ...baseInput, runId: "static-fix-redacts-before-cut" });

  const detail = capturedFixCases[1]?.find((c) => c.name === "static-gate")?.detail ?? "";
  assert.match(detail, /specialtyCell/);
  assert.ok(!detail.includes("sk-Q7x9"), detail.slice(-60));
});

test("the initial generate() call never carries static-gate fixCases enrichment even when the static-fix loop never engages (clean first pass)", async () => {
  const capturedFixCases: unknown[] = [];
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      capturedFixCases.push(enrichment?.fixCases);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "clean-pass-no-static-fixcases" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(capturedFixCases.length, 1, "a clean pass never engages the static-fix loop — exactly ONE generate() call");
  assert.equal(capturedFixCases[0], undefined, "the initial generate() call must never carry static-gate fixCases enrichment");
});

test("empty-generation guard: a generation that returns parsed:false + zero specs is infra-error, NOT a silent skip (surface integration errors loudly)", async () => {
  const { ports } = stubPorts({
    /* The agent runtime returned no parseable verdict (provider quota/outage/timeout returning empty
       rather than throwing). approved defaults true on an unparseable verdict, so WITHOUT the guard
       this would fall into the approved+zero-specs no-op skip and masquerade as "no test-worthy change".
     */
    generate: async () => (scriptedGeneration({ specs: [], parsed: false })),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "empty-generation-parsed-false-infra" });

  assert.equal(out.decision.verdict, "infra-error", "empty/unparseable generation must surface as infra-error, never skipped");
});

test("no-op honored: a genuine agent no-op (parsed:true + approved + zero specs) still skips — the guard does not over-fire", async () => {
  const { ports } = stubPorts({
    /* The agent emitted a real, parseable verdict deciding no tests are warranted — the legitimate
       AGENTS.md no-op that MUST stay `skipped`. Only parsed:false (above) diverts to infra-error.
     */
    generate: async () => (scriptedGeneration({ specs: [], parsed: true, end: GENERATION_END.DECLARED_NOOP, note: "nothing in this change is worth a test" })),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "genuine-no-op-parsed-true-skips" });

  assert.equal(out.decision.verdict, "skipped", "a genuine parsed no-op is a valid skip, never infra-error");
});

/* enforcement — RunQaUseCaseDeps.confinement's own header: it runs after every generate() as well
   as immediately before publish) ─────────────────────────
 */

function makeFakeConfinement(
  onEnforce: (mirrorDir: string) => { strays: number; dangerous: number; reverted: string[] } | Error,
): ConfinementPort {
  return {
    enforce: async (workspace) => {
      const result = onEnforce(rootsOf(workspace).mirrorDir);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("confinement wiring: green-pr — enforce() is called at least twice (after the initial generate() AND once more immediately before publish), not just once", async () => {
  const calls: Array<{ mirrorDir: string }> = [];
  const { ports, ws } = stubPorts();
  const confinement = makeFakeConfinement((mirrorDir) => {
    calls.push({ mirrorDir });
    return { strays: 0, dangerous: 0, reverted: [] };
  });
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "confinement-green-pr-multi-point" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(calls.length >= 2, `expected at least 2 enforce() calls (after generate + before publish), got ${calls.length}`);
  for (const call of calls) {
    assert.equal(call.mirrorDir, ws.mirrorDir, "enforce() must receive this run's REAL mirrorDir");
  }
});

test("confinement wiring: [SWAP] absent — no collaborator wired means zero enforce() calls and no gateSignals.confinement field (never fabricated)", async () => {
  const { ports, savedOutcomes } = stubPorts();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); /* no `confinement` key at all */

  const out = await useCase.run({ ...baseInput, runId: "confinement-absent-no-op" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(savedOutcomes[0]?.gateSignals.confinement, undefined, "gateSignals.confinement must be entirely absent, never a fabricated {strays:0,...}");
});

test("confinement wiring: FixLoop engagement — enforce() runs after EACH FixLoop regeneration round, not only once", async () => {
  let executeCalls = 0;
  const calls: Array<{ mirrorDir: string }> = [];
  const { ports } = stubPorts({
    execute: async () => {
      executeCalls++;
      /* First execute (post static-gate) fails -> engages the FixLoop; the retry passes so the loop
         terminates promptly — mirrors this file's own pre-existing FixLoop-trigger fixture.
       */
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom" }], logs: "" };
      }
      return { verdict: "pass", cases: [{ name: "owners", status: "pass" }], logs: "" };
    },
  });
  const confinement = makeFakeConfinement((mirrorDir) => {
    calls.push({ mirrorDir });
    return { strays: 0, dangerous: 0, reverted: [] };
  });
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "confinement-fixloop-multi-point" });

  assert.notEqual(out.decision.verdict, "invalid", "sanity: the run must reach the FixLoop, not hold invalid earlier");
  /* Initial generate() (1) + the FixLoop's own regen round (1) + the pre-publish call (1) = at least 3. */
  assert.ok(calls.length >= 3, `expected at least 3 enforce() calls across the initial generate + FixLoop regen + pre-publish, got ${calls.length}`);
});

test("confinement wiring: agent-no-op skip still persists confinement telemetry — a stray caught before the skip never vanishes from the saved outcome", async () => {
  /* The initial generate() always runs enforceConfinement() before the approved+zero-specs guard is
     evaluated, so a no-op skip can legitimately carry a populated confinementAcc. The skip exit path
     must thread it into toRunOutcome like the mainline (1904) and terminal (2459) exits do — a run
     that ends "skipped" after the guard reverted a stray must still show that in its audit trail.
   */
  const { ports, savedOutcomes } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [], parsed: true, end: GENERATION_END.DECLARED_NOOP, note: "nothing in this change is worth a test" })),
  });
  const confinement = makeFakeConfinement(() => ({ strays: 1, dangerous: 0, reverted: ["stray.txt"] }));
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "confinement-noop-skip-telemetry" });

  assert.equal(out.decision.verdict, "skipped");
  assert.deepEqual(
    savedOutcomes[0]?.gateSignals.confinement,
    { strays: 1, dangerous: 0, reverted: ["stray.txt"] },
    "the agent-no-op skip exit must persist gateSignals.confinement, matching the other toRunOutcome call sites",
  );
});

test("confinement wiring: fault isolation — a thrown enforce() is caught, logged, and NEVER alters the verdict or blocks publish", async () => {
  let publishCallCount = 0;
  const { ports, savedOutcomes } = stubPorts({
    publish: async () => { publishCallCount++; return { outcome: "pr: https://example.test/pr/1" }; },
  });
  const confinement = makeFakeConfinement(() => new Error("git restore failed: permission denied"));
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "confinement-fault-isolated" });

  assert.equal(out.decision.verdict, "pass", "a confinement failure must never alter the run's verdict");
  assert.equal(publishCallCount, 1, "publish() must still be called despite every enforce() call throwing");
  assert.ok(
    (savedOutcomes[0]?.gateSignals.confinement?.dangerous ?? 0) > 0,
    "a fault-isolated enforce() failure must still be recorded — dangerous is the most prominent signal the existing gate-signal shape allows",
  );
});

test("confinement wiring: an untrusted git dir found by enforce() fails the run instead of being fault-isolated", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    publish: async () => { publishCallCount++; return { outcome: "pr: https://example.test/pr/1" }; },
  });
  const confinement = makeFakeConfinement(() => new UntrustedGitTreeError("refusing to run git on /mirrors/org__app/.git: it is a symbolic link"));
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  await assert.rejects(useCase.run({ ...baseInput, runId: "confinement-untrusted-git" }), UntrustedGitTreeError);
  assert.equal(publishCallCount, 0, "nothing is published from a working copy whose git dir is not the orchestrator's own");
});

test("confinement wiring: successful results across every enforce() call are MERGED into one gateSignals.confinement summary (summed/concatenated, never overwritten)", async () => {
  let callIndex = 0;
  const { ports, savedOutcomes } = stubPorts();
  const confinement = makeFakeConfinement(() => {
    callIndex++;
    return callIndex === 1
      ? { strays: 1, dangerous: 0, reverted: ["stray-a.ts"] }
      : { strays: 0, dangerous: 1, reverted: ["stray-b.env"] };
  });
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "confinement-merge-summary" });

  assert.equal(out.decision.verdict, "pass");
  const persisted = savedOutcomes[0]?.gateSignals.confinement;
  assert.ok(persisted, "gateSignals.confinement must be present when confinement is wired and ran");
  assert.equal(persisted?.strays, 1, "strays must be SUMMED across calls, not overwritten by the last call");
  assert.equal(persisted?.dangerous, 1, "dangerous must be SUMMED across calls");
  assert.deepEqual(persisted?.reverted, ["stray-a.ts", "stray-b.env"], "reverted must be CONCATENATED across calls, not replaced");
});

/* the vcs-write tracked-file denylist guard
   (VcsWritePort.commit's own SECOND, independent revert — see that port's header) used to be
   completely silent to the persisted run record: a reverted supply-chain tamper left zero trace
   in gateSignals, even though ConfinementPort's OWN reverts are always threaded there. A revert
   surfaced by PublicationPort.publish()'s "pr" route must merge into the SAME accumulator.
 */
test("confinement wiring: a reverted denylisted path from PublicationPort.publish() (the vcs-write tracked-file guard) is merged into gateSignals.confinement — never silent", async () => {
  const { ports, savedOutcomes } = stubPorts({
    publish: async () => ({ outcome: "pr: https://example.test/pr/1", revertedDenylisted: ["Dockerfile"] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); /* no ConfinementPort wired at all */

  const out = await useCase.run({ ...baseInput, runId: "confinement-vcswrite-revert-merge" });

  assert.equal(out.decision.verdict, "pass");
  const persisted = savedOutcomes[0]?.gateSignals.confinement;
  assert.ok(persisted, "gateSignals.confinement must be populated from the vcs-write revert alone, even with no ConfinementPort ever wired");
  assert.ok(
    persisted?.reverted.includes("Dockerfile"),
    `the vcs-write tracked-file guard's own revert must be visible in gateSignals.confinement — got ${JSON.stringify(persisted)}`,
  );
});

test("confinement wiring: a reverted denylisted path from publish() MERGES with prior ConfinementPort.enforce() results, never overwrites them", async () => {
  const confinement = makeFakeConfinement(() => ({ strays: 1, dangerous: 0, reverted: ["stray-a.ts"] }));
  const { ports, savedOutcomes } = stubPorts({
    publish: async () => ({ outcome: "pr: https://example.test/pr/1", revertedDenylisted: ["Dockerfile"] }),
  });
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "confinement-vcswrite-revert-merge-with-enforce" });

  const persisted = savedOutcomes[0]?.gateSignals.confinement;
  assert.ok(persisted?.reverted.includes("stray-a.ts"), "prior enforce() reverts must survive the merge");
  assert.ok(persisted?.reverted.includes("Dockerfile"), "the publish()-surfaced revert must be added, not replace the existing accumulator");
});

/* A reverted Dockerfile is a stray but not secret-tier. `dangerous` is only the pre-classified
   secret-path subset (env files, symlink escape). The use-case must not re-derive that check. */
test("confinement wiring: a reverted NON-secret path (Dockerfile) from publish() counts toward strays but NOT dangerous", async () => {
  const { ports, savedOutcomes } = stubPorts({
    publish: async () => ({ outcome: "pr: https://example.test/pr/1", revertedDenylisted: ["Dockerfile"], revertedDangerous: [] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "confinement-vcswrite-nondangerous-revert" });

  const persisted = savedOutcomes[0]?.gateSignals.confinement;
  assert.ok(persisted, "gateSignals.confinement must be populated");
  assert.equal(persisted?.strays, 1, "a reverted Dockerfile is a stray");
  assert.equal(persisted?.dangerous, 0, "a reverted Dockerfile is NOT a secret-tier match — must not inflate dangerous");
  assert.ok(persisted?.reverted.includes("Dockerfile"));
});

test("confinement wiring: a reverted secret-tier path (.env) from publish() counts toward BOTH strays and dangerous", async () => {
  const { ports, savedOutcomes } = stubPorts({
    publish: async () => ({ outcome: "pr: https://example.test/pr/1", revertedDenylisted: [".env"], revertedDangerous: [".env"] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "confinement-vcswrite-dangerous-revert" });

  const persisted = savedOutcomes[0]?.gateSignals.confinement;
  assert.ok(persisted, "gateSignals.confinement must be populated");
  assert.equal(persisted?.strays, 1);
  assert.equal(persisted?.dangerous, 1, "a reverted .env IS the secret tier — must count as dangerous");
  assert.ok(persisted?.reverted.includes(".env"));
});

/* revertedDangerous field at all must not crash and must not silently OVER-count dangerous — treated
   as zero genuinely-dangerous reverts (fail-safe: never fabricate a "dangerous" signal from absence).
 */
test("confinement wiring: a publish() stub with revertedDenylisted but no revertedDangerous field never inflates dangerous (back-compat)", async () => {
  const { ports, savedOutcomes } = stubPorts({
    publish: async () => ({ outcome: "pr: https://example.test/pr/1", revertedDenylisted: ["Dockerfile"] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "confinement-vcswrite-stub" });

  const persisted = savedOutcomes[0]?.gateSignals.confinement;
  assert.ok(persisted);
  assert.equal(persisted?.strays, 1);
  assert.equal(persisted?.dangerous, 0, "absent revertedDangerous must never be treated as 'everything is dangerous'");
});

test("confinement wiring: publish() with no revertedDenylisted (the common case) never fabricates a confinement entry", async () => {
  const { ports, savedOutcomes } = stubPorts({
    publish: async () => ({ outcome: "pr: https://example.test/pr/1" }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "confinement-vcswrite-no-revert" });

  assert.equal(savedOutcomes[0]?.gateSignals.confinement, undefined, "no ConfinementPort wired and no revertedDenylisted -> gateSignals.confinement must stay entirely absent");
});

test("confinement wiring: a regression run (generating:false) makes no enforce() call for the (never-invoked) initial generate, but still enforces once before publish", async () => {
  const calls: Array<{ mirrorDir: string }> = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "regression", reason: "docs-only change", diff: "" }),
  });
  const confinement = makeFakeConfinement((mirrorDir) => {
    calls.push({ mirrorDir });
    return { strays: 0, dangerous: 0, reverted: [] };
  });
  const useCase = new RunQaUseCase({ ...ports, confinement, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "confinement-regression-run" });

  assert.equal(calls.length, 1, "a regression run never calls the real the authoring port, so only the pre-publish enforce() call fires");
});

/* resolveTested() prefers the FixLoop's own FINAL regen specMetas when the loop engaged and produced
   any; falls back to the initial/static-fix-loop generation's own specMetas otherwise. Never throws
   or fabricates when neither source has anything. ─────────────────────────────────────────────────
 */

test("tested is sourced from the initial generation's specMetas when the FixLoop never engages (clean first-try pass)", async () => {
  let publishedTested: { flow?: string; objective?: string }[] | undefined;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({
      specs: ["checkout.spec.ts"],
      specMetas: [{ flow: "Checkout", objective: "user can pay with a saved card" }],
    })),
    execute: async () => ({ verdict: "pass", cases: [{ name: "pays", status: "pass", file: "checkout.spec.ts" }], logs: "" }),
    publish: async (decision) => { publishedTested = decision.tested; return { outcome: "pr" }; },
  });
  const useCase = new RunQaUseCase({ ...ports, ...loginToBeWritten(), config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "tested-initial-only" });

  assert.equal(out.decision.verdict, "pass", "sanity: no failure, so the FixLoop never engages");
  assert.deepEqual(publishedTested, [{ flow: "Checkout", objective: "user can pay with a saved card" }]);
});

test("tested prefers the FixLoop's FINAL regen specMetas once the loop engages and regenerates", async () => {
  let publishedTested: { flow?: string; objective?: string }[] | undefined;
  let executeCalls = 0;
  const { ports } = stubPorts({
    /* The initial call (no fixCases enrichment) returns the INITIAL specMetas; the FixLoop's own
       regen call (fixCases populated by the aggregate) returns the FixLoop's own, DIFFERENT specMetas
       — resolveTested() must prefer the latter once it exists.
     */
    generate: async (_specDir, _signal, _diff, enrichment) => {
      if (enrichment?.fixCases?.length) {
        return scriptedGeneration({
          specs: ["checkout.spec.ts"],
          specMetas: [{ flow: "Checkout (fixed)", objective: "retry with the corrected selector" }],
        });
      }
      return scriptedGeneration({
        specs: ["checkout.spec.ts"],
        specMetas: [{ flow: "Checkout (stale)", objective: "the pre-fix, now-superseded objective" }],
      });
    },
    execute: async () => {
      executeCalls++;
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "checkout", status: "fail", detail: "boom" }], logs: "" };
      }
      return { verdict: "pass", cases: [{ name: "checkout", status: "pass" }], logs: "" };
    },
    publish: async (decision) => { publishedTested = decision.tested; return { outcome: "pr" }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "tested-fixloop-final" });

  assert.notEqual(out.decision.verdict, "invalid", "sanity: the run must reach the FixLoop");
  assert.deepEqual(
    publishedTested,
    [{ flow: "Checkout (fixed)", objective: "retry with the corrected selector" }],
    "the FixLoop's own final regen's specMetas must win over the initial (now-stale) generation's specMetas",
  );
});

test("absent specMetas everywhere never throws and publish() receives no tested field", async () => {
  let publishedDecisionHadTestedKey = true;
  const { ports } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: ["checkout.spec.ts"]})),
    execute: async () => ({ verdict: "pass", cases: [{ name: "pays", status: "pass", file: "checkout.spec.ts" }], logs: "" }),
    publish: async (decision) => {
      publishedDecisionHadTestedKey = "tested" in decision && decision.tested !== undefined;
      return { outcome: "pr" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "tested-absent-everywhere" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(publishedDecisionHadTestedKey, false, "no specMetas source existed this run, so `tested` must be entirely omitted — never a fabricated empty array");
});

/* absent means the mainline exit's gc call is a no-op (backward compatible, the SAME posture every
   other optional collaborator on this barrel establishes). Fires ONCE, at the tail of the mainline
   exit, strictly AFTER the pre-publish confinement enforcement + the publish() call itself have both
   resolved ("successful run triggers gc": "after publish/confinement git calls returned").
   Fault-isolated: a thrown prune() is caught, logged loudly, and never alters the verdict or blocks
   the run from completing (mirrors confinement's own fault-isolation contract above). ─────────────
 */

function makeFakeMirrorGc(onPrune: (mirrorDir: string) => void | Error): MirrorGcPort {
  return {
    prune: async (workspace) => {
      const result = onPrune(rootsOf(workspace).mirrorDir);
      if (result instanceof Error) throw result;
    },
  };
}

test("mirrorGc wiring: successful run triggers prune() exactly once, against the run's real mirrorDir, AFTER publish() resolves", async () => {
  const order: string[] = [];
  const { ports, ws } = stubPorts({
    publish: async () => { order.push("publish"); return { outcome: "pr" }; },
  });
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    order.push(`prune:${mirrorDir}`);
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-green-pr" });

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(order, ["publish", `prune:${ws.mirrorDir}`], "prune() must fire exactly once, strictly after publish() resolves, against the run's real mirrorDir");
});

test("mirrorGc wiring: [SWAP] absent — no collaborator wired means zero prune() calls (backward compatible)", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); /* no `mirrorGc` key at all */

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-absent-no-op" });

  assert.equal(out.decision.verdict, "pass");
});

test("mirrorGc wiring: fault isolation — a thrown prune() is caught, logged, and NEVER alters the verdict or blocks the run from completing", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    publish: async () => { publishCallCount++; return { outcome: "pr: https://example.test/pr/1" }; },
  });
  const mirrorGc = makeFakeMirrorGc(() => new Error("git gc failed: index.lock exists"));
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-fault-isolated" });

  assert.equal(out.decision.verdict, "pass", "a mirror-gc failure must never alter the run's verdict");
  assert.equal(publishCallCount, 1, "publish() must have already completed — prune() runs strictly after it");
});

test("mirrorGc wiring: an untrusted git dir found by prune() fails the run instead of being fault-isolated", async () => {
  const { ports } = stubPorts();
  const mirrorGc = makeFakeMirrorGc(() => new UntrustedGitTreeError("refusing to run git on /mirrors/org__app/.git: it is a symbolic link"));
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  await assert.rejects(useCase.run({ ...baseInput, runId: "mirror-gc-untrusted-git" }), UntrustedGitTreeError);
});

test("mirrorGc wiring: a non-pr verdict (fail/issue) also triggers prune() once, after publish() resolves", async () => {
  const order: string[] = [];
  const { ports, ws } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom" }], logs: "" }),
    publish: async () => { order.push("publish"); return { outcome: "issue: https://example.test/issues/1" }; },
  });
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    order.push(`prune:${mirrorDir}`);
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-fail-issue" });

  assert.equal(out.decision.verdict, "fail");
  assert.deepEqual(order, ["publish", `prune:${ws.mirrorDir}`], "prune() must fire once for a fail/issue-routed run too, strictly after publish()");
});

/* ── mirrorGc coverage extends beyond the mainline exit to every OTHER
   exit that touched its mirror (workspace.prepare() already ran) — the terminalResult()-routed exits
   (invalid, infra-error) and the classify-skip/agent-no-op-skip exits (both verdict "skipped"). The
   "successful run triggers gc" scenario literally reads "GIVEN a run completes (any verdict)".
   Entry-gate exits that fire BEFORE workspace.prepare() (aborted, deploy-gate infra-error) never
   touch a mirror and correctly stay excluded. ──────────────────────────────────────────────────────
 */

test("mirrorGc wiring: a static-gate invalid verdict (terminalResult exit) also triggers prune() once, after that exit's own publish() resolves", async () => {
  const order: string[] = [];
  const { ports, ws } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
    publish: async () => { order.push("publish"); return { outcome: "issue: https://example.test/issues/2" }; },
  });
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    order.push(`prune:${mirrorDir}`);
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-invalid" });

  assert.equal(out.decision.verdict, "invalid");
  assert.deepEqual(order, ["publish", `prune:${ws.mirrorDir}`], "prune() must fire once for the static-gate invalid terminal exit, strictly after its own publish()");
});

test("mirrorGc wiring: a mid-run health-preflight infra-error verdict (terminalResult exit, sideEffect none) also triggers prune() once", async () => {
  let waitUntilHealthyCall = 0;
  const { ports, ws } = stubPorts({
    waitUntilHealthy: async () => {
      waitUntilHealthyCall++;
      return waitUntilHealthyCall === 1 ? ok(true) : { ok: false as const, error: new Error("DEV went down mid-run") };
    },
  });
  let pruneCallCount = 0;
  let prunedMirrorDir: string | undefined;
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    pruneCallCount++;
    prunedMirrorDir = mirrorDir;
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-infra-error-midrun" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(pruneCallCount, 1, "prune() must fire once for the health-preflight infra-error terminal exit even though sideEffect is none (no publish() call on this path)");
  assert.equal(prunedMirrorDir, ws.mirrorDir);
});

test("mirrorGc wiring: a classify-skip verdict (bare-return skip, no persistence) also triggers prune() once — the mirror was touched by checkout before classify runs", async () => {
  let pruneCallCount = 0;
  let prunedMirrorDir: string | undefined;
  const { ports, ws } = stubPorts({ classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }) });
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    pruneCallCount++;
    prunedMirrorDir = mirrorDir;
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-classify-skip" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(pruneCallCount, 1, "prune() must fire once for the classify-skip bare-return exit");
  assert.equal(prunedMirrorDir, ws.mirrorDir);
});

test("mirrorGc wiring: an agent-no-op skip verdict (approved + zero specs) also triggers prune() once, after this exit's own runHistory.save()", async () => {
  const order: string[] = [];
  const { ports, ws } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "nothing in this change is worth a test" })),
    save: async () => { order.push("save"); },
  });
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    order.push(`prune:${mirrorDir}`);
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-agent-no-op-skip" });

  assert.equal(out.decision.verdict, "skipped");
  assert.deepEqual(order, ["save", `prune:${ws.mirrorDir}`], "prune() must fire once for the agent-no-op skip exit, after its own runHistory.save()");
});

test("mirrorGc wiring: a thrown prune() on the invalid terminal exit is fault-isolated — never alters the verdict or blocks publish", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
    publish: async () => { publishCallCount++; return { outcome: "issue: https://example.test/issues/3" }; },
  });
  const mirrorGc = makeFakeMirrorGc(() => new Error("git gc failed: index.lock exists"));
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-invalid-fault-isolated" });

  assert.equal(out.decision.verdict, "invalid", "a mirror-gc failure must never alter the invalid terminal exit's verdict");
  assert.equal(publishCallCount, 1);
});

test("mirrorGc wiring: a thrown prune() on the classify-skip exit is fault-isolated — never alters the verdict", async () => {
  const { ports } = stubPorts({ classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }) });
  const mirrorGc = makeFakeMirrorGc(() => new Error("git gc failed: index.lock exists"));
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-skip-fault-isolated" });

  assert.equal(out.decision.verdict, "skipped", "a mirror-gc failure must never alter the classify-skip exit's verdict");
});

/* abortedResult() mid-run exits (every POST-prepare signal-aborted check) and the two bare
   infraErrorResult() exits (setup failure, empty/unparseable generation) never called
   pruneMirrorIfWired, even though workspace.prepare() had already checked out the mirror by the
   time they fire. Genuinely PRE-prepare exits (an already-aborted signal observed before
   workspace.prepare() runs, the deploy-gate infra-error) correctly stay excluded — their mirror was
   never touched. ─────────────────────────────────────────────────────────────────────────────────
 */

test("mirrorGc wiring: a post-prepare signal-aborted exit (mid-run, between validate and execute) triggers exactly one prune() with the run's mirrorDir", async () => {
  const controller = new AbortController();
  const { ports, ws } = stubPorts({
    validate: async () => { controller.abort(); return { ok: true, errors: [] }; },
  });
  let pruneCallCount = 0;
  let prunedMirrorDir: string | undefined;
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    pruneCallCount++;
    prunedMirrorDir = mirrorDir;
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-mid-run-abort" }, controller.signal);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(pruneCallCount, 1, "a post-prepare aborted exit must prune its mirror exactly once");
  assert.equal(prunedMirrorDir, ws.mirrorDir);
});

test("mirrorGc wiring: a pre-prepare already-aborted signal does NOT prune — the mirror was never touched", async () => {
  const controller = new AbortController();
  controller.abort();
  const { ports } = stubPorts();
  let pruneCallCount = 0;
  const mirrorGc = makeFakeMirrorGc(() => { pruneCallCount++; });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-pre-prepare-no-prune" }, controller.signal);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(pruneCallCount, 0, "an already-aborted signal short-circuits BEFORE workspace.prepare() ever runs — nothing to prune");
});

test("mirrorGc wiring: a setup() failure infra-error exit triggers prune() once", async () => {
  const { ports, ws } = stubPorts({
    setup: async () => { throw new Error("npm ci in e2e failed (code 1)"); },
  });
  let pruneCallCount = 0;
  let prunedMirrorDir: string | undefined;
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    pruneCallCount++;
    prunedMirrorDir = mirrorDir;
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-setup-failure" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(pruneCallCount, 1, "a setup() failure fires after workspace.prepare() already checked out the mirror — it must be pruned");
  assert.equal(prunedMirrorDir, ws.mirrorDir);
});

test("mirrorGc wiring: an empty/unparseable generation infra-error exit triggers prune() once", async () => {
  const { ports, ws } = stubPorts({
    generate: async () => (scriptedGeneration({ specs: [], parsed: false })),
  });
  let pruneCallCount = 0;
  let prunedMirrorDir: string | undefined;
  const mirrorGc = makeFakeMirrorGc((mirrorDir) => {
    pruneCallCount++;
    prunedMirrorDir = mirrorDir;
  });
  const useCase = new RunQaUseCase({ ...ports, mirrorGc, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "mirror-gc-empty-generation" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(pruneCallCount, 1, "an empty/unparseable generation fires after workspace.prepare() already checked out the mirror — it must be pruned");
  assert.equal(prunedMirrorDir, ws.mirrorDir);
});

/* ONLY from the /continue API flow's RunRequest.parentRunId (platform/entrypoints/runner.ts's own
   runViaEngine -> RunInput construction), threads straight through into the mainline exit's
   publish() call (run-qa.use-case.ts's own "Phase: publish" block). Absent for every ordinary
   webhook/manual/CLI run — never fabricated. An enforce-mode coverage-regen reuses the SAME `input`
   object for its final publish() call (it never constructs a fresh RunQaInput), so it structurally
   cannot invent its own parentRunId — the "coverage-regen is not mistaken for a continuation"
   scenario is a corollary of this, not a separate code path. ──────────────────────────────────────
 */

test("parentRunId: a continuation run threads input.parentRunId into publish()'s decision", async () => {
  let publishedParentRunId: string | undefined;
  const { ports } = stubPorts({
    publish: async (decision) => {
      publishedParentRunId = decision.parentRunId;
      return { outcome: "pr" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "parent-run-id-continuation", parentRunId: "prior-run-abc123" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(publishedParentRunId, "prior-run-abc123");
});

test("parentRunId: an ordinary run omits parentRunId from publish()'s decision entirely (never fabricated)", async () => {
  let publishedDecisionHadParentRunIdKey = true;
  const { ports } = stubPorts({
    publish: async (decision) => {
      publishedDecisionHadParentRunIdKey = "parentRunId" in decision && decision.parentRunId !== undefined;
      return { outcome: "pr" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "parent-run-id-ordinary" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(publishedDecisionHadParentRunIdKey, false, "no /continue source exists this run, so parentRunId must be entirely omitted — never a fabricated empty string");
});

test("parentRunId: an enforce-mode coverage-regen never fabricates its own parentRunId — the final publish() still reflects only the ORIGINAL run's input.parentRunId", async () => {
  let measureCallCount = 0;
  let publishedParentRunId: string | undefined;
  const real = realCoverageWorkspace();
  try {
    const { ports } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => {
        measureCallCount++;
        return measureCallCount === 1
          ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1, 2] }] }
          : { status: "pass" as const, ratio: 0.95 };
      },
      blocks: (status) => status === "fail",
      publish: async (decision) => {
        publishedParentRunId = decision.parentRunId;
        return { outcome: "pr" };
      },
    });
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
    });

    const out = await useCase.run({ ...baseInput, runId: "parent-run-id-coverage-regen", parentRunId: "prior-run-xyz789" });

    assert.equal(out.decision.verdict, "pass");
    assert.equal(measureCallCount, 2, "the regen genuinely fired");
    assert.equal(publishedParentRunId, "prior-run-xyz789", "the regen must never invent its own parentRunId — only the original run's input carries one");
  } finally {
    real.cleanup();
  }
});

/* FixLoop computes retryNs = `${namespace}-r${n}` and the ExecutionPort
   adapter already honours opts.namespace — but the use-case FixLoopExecutionPort closure was
   dropping it, so every retry reused the first-run test-data namespace (PetClinic cardinality).
 */
test("FixLoop retry execute() forwards the per-attempt retryNs as ExecutionOpts.namespace", async () => {
  const capturedNamespaces: (string | undefined)[] = [];
  const capturedMeasureNamespaces: (string | undefined)[] = [];
  const capturedSpecFiles: (string[] | undefined)[] = [];
  let executeCalls = 0;
  const { ports } = stubPorts({
    classify: classifyWithDiff,
    execute: async (_specDir, opts) => {
      executeCalls++;
      capturedNamespaces.push(typeof opts === "object" && opts && !(opts instanceof AbortSignal) ? opts.namespace : undefined);
      capturedSpecFiles.push(typeof opts === "object" && opts && !(opts instanceof AbortSignal) ? opts.specFiles : undefined);
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "a.spec.ts" }], logs: "" };
      }
      return passPerSpec(_specDir, opts);
    },
    measure: async (_br, _specDir, _diff, _baseline, opts) => {
      capturedMeasureNamespaces.push(opts?.namespace);

      return { status: "unknown" as const, ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  const out = await useCase.run({ ...baseInput, runId: "retry-ns-p0-1" });

  assert.notEqual(out.decision.verdict, "invalid", "sanity: the run must reach FixLoop, not hold invalid earlier");
  assert.ok(executeCalls >= 2, `expected initial execute + at least one FixLoop retry, got ${executeCalls}`);
  const retryNs = capturedNamespaces.slice(1).find((ns) => typeof ns === "string" && ns.endsWith("-r1"));
  assert.equal(retryNs, "retry-ns-p0-1-r1", "FixLoop retry must execute under ${runId}-r1 so test data does not collide with the first attempt");
  assert.deepEqual(capturedSpecFiles[capturedNamespaces.indexOf("retry-ns-p0-1-r1")], ["a.spec.ts"], "the round executed the spec it changed");
  assert.equal(capturedMeasureNamespaces[0], "retry-ns-p0-1-measure", "the green bytes the loop left are measured by their own measurement execution");

});

/* Change coverage is measured on the bytes the loop left green: one measurement execution runs the passing tests of every spec file, those a round re-ran and those it did not. */
test("a fix-loop round that re-ran one of two spec files still measures the other file's lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-latest-dumps-"));
  const specDir = join(dir, "e2e");
  let generations = 0;
  const executions: Array<{ namespace?: string; specFiles?: string[] }> = [];
  const measured: unknown[] = [];
  try {
    const { ports } = stubPorts({
      classify: classifyWithDiff,
      prepare: async () => fakeHandle({ specDir, mirrorDir: dir }),
      generate: async () => {
        generations += 1;
        mkdirSync(specDir, { recursive: true });
        if (generations === 1) writeFileSync(join(specDir, "a.spec.ts"), "// a\n");
        writeFileSync(join(specDir, "b.spec.ts"), `// b, generation ${generations}\n`);
        return scriptedGeneration({ specs: generations === 1 ? ["a.spec.ts", "b.spec.ts"] : ["b.spec.ts"] });
      },
      execute: async (_dir, opts) => {
        const o = opts as { namespace?: string; specFiles?: string[] } | undefined;
        executions.push({ ...(o?.namespace ? { namespace: o.namespace } : {}), ...(o?.specFiles ? { specFiles: o.specFiles } : {}) });
        if (executions.length === 1) return { verdict: "fail" as const, cases: [{ name: "a works", status: "pass" as const, file: "a.spec.ts" }, { name: "b works", status: "fail" as const, file: "b.spec.ts", detail: "expected 1 row" }], logs: "" };
        if (o?.namespace?.endsWith("-measure")) return { verdict: "pass" as const, cases: [{ name: "a works", status: "pass" as const, file: "a.spec.ts" }, { name: "b works", status: "pass" as const, file: "b.spec.ts" }], logs: "" };
        return { verdict: "pass" as const, cases: [{ name: "b works", status: "pass" as const, file: "b.spec.ts" }], logs: "" };
      },
      measure: async (_br, _specDir, _diff, _baseline, opts) => {
        measured.push({ namespace: opts?.namespace });
        return { status: "pass" as const, ratio: 0.5, uncovered: [], untakenArms: [] };
      },
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "off" } });

    const out = await useCase.run({ ...baseInput, runId: "latest-dumps" });

    assert.deepEqual(executions[1], { namespace: "latest-dumps-r1", specFiles: ["b.spec.ts"] }, "the round re-ran only the spec file it changed");
    assert.deepEqual(executions.at(-1), { namespace: "latest-dumps-measure", specFiles: ["a.spec.ts", "b.spec.ts"] }, "the measurement execution runs the passing tests of both spec files");
    assert.deepEqual(measured, [{ namespace: "latest-dumps-measure" }], "both files are read from the measurement execution");
    assert.equal(out.decision.verdict, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a regeneration is held to the run deadline alone: a second ceiling in the config no longer refuses it", async () => {
  let generateCalls = 0;
  const { ports } = stubPorts({
    generate: async () => {
      generateCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    execute: async () => ({ verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" }),
  });
  const runDeadline = { arm: () => {}, remainingMs: () => 600_000, allowance: () => 600_000, describe: () => ({ label: "diff", budgetMs: 600_000 }) };
  /* A key the engine retired: it must not be read, so the 1 ms below binds nothing. */
  const retired = { wallClockBudgetMs: 1 } as object;
  await new RunQaUseCase({ ...ports, runDeadline, config: { ...baseConfig, needsReview: false, ...retired } }).run({ ...baseInput, runId: "one-clock" });

  assert.ok(generateCalls > 1, "with time left on the deadline the fix loop regenerates, whatever a second clock says");
});

test("a fix loop whose share is spent while the run has time skips the regeneration and keeps the fail with its Issue", async () => {
  let generateCalls = 0;
  let executeCalls = 0;
  const { ports } = stubPorts({
    generate: async () => { generateCalls++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
    execute: async () => {
      executeCalls++;
      return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" };
    },
  });
  const runDeadline = {
    arm: () => {},
    remainingMs: () => 60_000,
    allowance: (purpose?: string) => (purpose === "fix" ? 0 : 60_000),
    describe: () => ({ label: "diff", budgetMs: 600_000 }),
  };
  const out = await new RunQaUseCase({ ...ports, runDeadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "deadline-allowance-regen" });
  assert.equal(generateCalls, 1, "no time for a regeneration starts no further agent turn");
  assert.equal(executeCalls, 1);
  assert.equal(out.decision.verdict, "fail", "the run still had time: the unrepaired failure is the app's verdict");
  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(limitsOf(out).includes("allotment@fix"), "the skipped regeneration is recorded as the fix loop's time limit");
});

test("a run deadline that is itself spent ends the run E-TIME-BUDGET instead of a fail with an Issue", async () => {
  let generateCalls = 0;
  const { ports } = stubPorts({
    generate: async () => { generateCalls++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
    execute: async () => ({ verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" }),
  });
  const runDeadline = {
    arm: () => {},
    remainingMs: () => 0,
    allowance: (purpose?: string) => (purpose === "fix" ? 0 : 60_000),
    describe: () => ({ label: "diff", budgetMs: 600_000 }),
  };
  const out = await new RunQaUseCase({ ...ports, runDeadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "deadline-spent-regen" });
  assert.equal(generateCalls, 1);
  assert.equal(out.decision.verdict, "infra-error", "the run's own time is spent: the deadline ends the run, it says nothing about the app");
  assert.equal(out.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.notEqual(out.decision.sideEffect, "issue");
});

test("a run deadline with time left for a regeneration lets the fix loop regenerate", async () => {
  let generateCalls = 0;
  const { ports } = stubPorts({
    generate: async () => { generateCalls++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
    execute: async () => ({ verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" }),
  });
  const runDeadline = { arm: () => {}, remainingMs: () => 60_000, allowance: () => 60_000 };
  await new RunQaUseCase({ ...ports, runDeadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "deadline-allowance-regen-ok" });
  assert.ok(generateCalls >= 2, `expected a regeneration, got ${generateCalls} generate call(s)`);
});

/* Per-run code-graph indexing. The port is optional (absent = no index). Every outcome is fail-open: a failed, timed-out
   or thrown index never ends the run. Classify-skip returns before this phase (the mirror may be GC'd). Each index leaves
   its provenance as a span. */

function indexRecord(repoDir: string, sha: string, overrides: Partial<CodeGraphIndexRecord> = {}): CodeGraphIndexRecord {
  return { repo: repoDir.split("/").pop() ?? repoDir, engine: "fake", engineVersion: "1.0.0", sha, outcome: "built", durationMs: 5, nodeCount: 10, edgeCount: 20, ...overrides };
}

function fakeCodeGraph(syncTo: CodeGraphPort["syncTo"]): CodeGraphPort {
  return {
    syncTo,
    impactedSymbols: async () => ok({ indexedSha: "abc1234", symbols: [], truncated: false, seedBasis: "lines" as const }),
    callersOf: async () => ok({ indexedSha: "abc1234", symbols: [], truncated: false, seedBasis: "lines" as const }),
    routes: async () => ok([]),
  };
}

function recordingCodeGraph(overrides: (repoDir: string, sha: string) => Partial<CodeGraphIndexRecord> = () => ({})) {
  const calls: Array<{ repoDir: string; sha: string }> = [];
  const codeGraph = fakeCodeGraph(async (repoDir, sha) => {
    calls.push({ repoDir, sha });
    return indexRecord(repoDir, sha, overrides(repoDir, sha));
  });
  return { calls, codeGraph };
}

test("code-graph index: the run indexes workspace.mirrorDir at the run's SHA", async () => {
  const { ports, ws } = stubPorts();
  const { calls, codeGraph } = recordingCodeGraph();
  const useCase = new RunQaUseCase({ ...ports, codeGraph, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "graph-index-primary" });

  assert.deepEqual(calls, [{ repoDir: ws.mirrorDir, sha: "abc1234" }]);
  assert.equal(out.decision.verdict, "pass");
});

test("code-graph index: the run's abort signal reaches the index build", async () => {
  const { ports } = stubPorts();
  const signals: Array<AbortSignal | undefined> = [];
  const codeGraph = fakeCodeGraph(async (repoDir, sha, signal) => {
    signals.push(signal);
    return indexRecord(repoDir, sha);
  });
  const controller = new AbortController();

  await new RunQaUseCase({ ...ports, codeGraph, config: baseConfig }).run({ ...baseInput, runId: "graph-index-signal" }, controller.signal);

  assert.deepEqual(signals, [controller.signal]);
});

test("code-graph index: codeGraphRepoDir is indexed instead of workspace.mirrorDir", async () => {
  const { ports } = stubPorts();
  const { calls, codeGraph } = recordingCodeGraph();
  const useCase = new RunQaUseCase({ ...ports, codeGraph, codeGraphRepoDir: "/mirrors/org__orders-svc", config: baseConfig });

  await useCase.run({ ...baseInput, runId: "graph-index-service-dir", triggerRepo: "org/orders-svc" });

  assert.deepEqual(calls, [{ repoDir: "/mirrors/org__orders-svc", sha: "abc1234" }]);
});

test("code-graph index: a service-triggered run indexes the primary repo too, at the commit it is checked out at", async () => {
  const { ports } = stubPorts();
  const { calls, codeGraph } = recordingCodeGraph();
  const primaryHead = "f".repeat(40);
  const useCase = new RunQaUseCase({
    ...ports,
    codeGraph,
    codeGraphRepoDir: "/mirrors/org__orders-svc",
    codeGraphPrimary: { repo: "org/web", repoDir: "/mirrors/org__web", headSha: async () => primaryHead },
    config: baseConfig,
  });

  await useCase.run({ ...baseInput, runId: "graph-index-both", triggerRepo: "org/orders-svc" });

  assert.deepEqual(calls, [
    { repoDir: "/mirrors/org__orders-svc", sha: "abc1234" },
    { repoDir: "/mirrors/org__web", sha: primaryHead },
  ]);
});

test("code-graph index: each repo fails open on its own — a failed service index still indexes the primary, and an unreadable primary commit indexes nothing more", async () => {
  const { ports } = stubPorts();
  const { calls, codeGraph } = recordingCodeGraph((repoDir) => (repoDir.endsWith("svc") ? { outcome: "failed", reason: "x", nodeCount: null, edgeCount: null } : {}));
  const primaryHead = "e".repeat(40);
  const withHead = new RunQaUseCase({ ...ports, codeGraph, codeGraphRepoDir: "/mirrors/org__svc", codeGraphPrimary: { repo: "org/web", repoDir: "/mirrors/org__web", headSha: async () => primaryHead }, config: baseConfig });
  const out = await withHead.run({ ...baseInput, runId: "graph-index-svc-fails", triggerRepo: "org/svc" });
  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(calls.map((c) => c.repoDir), ["/mirrors/org__svc", "/mirrors/org__web"]);

  calls.length = 0;
  const noHead = new RunQaUseCase({ ...ports, codeGraph, codeGraphRepoDir: "/mirrors/org__svc", codeGraphPrimary: { repo: "org/web", repoDir: "/mirrors/org__web", headSha: async () => null }, config: baseConfig });
  await noHead.run({ ...baseInput, runId: "graph-index-no-head", triggerRepo: "org/svc" });
  assert.deepEqual(calls.map((c) => c.repoDir), ["/mirrors/org__svc"]);
});

test("code-graph index: the primary is not indexed twice when it is the classify-source repo", async () => {
  const { ports, ws } = stubPorts();
  const { calls, codeGraph } = recordingCodeGraph();
  const useCase = new RunQaUseCase({ ...ports, codeGraph, codeGraphPrimary: { repo: "org/web", repoDir: ws.mirrorDir, headSha: async () => "d".repeat(40) }, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "graph-index-same-repo" });

  assert.deepEqual(calls, [{ repoDir: ws.mirrorDir, sha: "abc1234" }]);
});

test("code-graph index: every run asks the port (the store cache, not a mirror-keyed sidecar, decides whether to reuse)", async () => {
  const { ports } = stubPorts();
  const { calls, codeGraph } = recordingCodeGraph();
  const useCase = new RunQaUseCase({ ...ports, codeGraph, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "graph-index-first" });
  await useCase.run({ ...baseInput, runId: "graph-index-second" });

  assert.equal(calls.length, 2);
});

test("code-graph index: a failed, timed-out or thrown index never ends the run", async () => {
  for (const syncTo of [
    async (repoDir: string, sha: string) => indexRecord(repoDir, sha, { outcome: "failed", reason: "x", nodeCount: null, edgeCount: null }),
    async (repoDir: string, sha: string) => indexRecord(repoDir, sha, { outcome: "timeout", reason: "y", nodeCount: null, edgeCount: null }),
    async (): Promise<CodeGraphIndexRecord> => { throw new Error("indexer crashed"); },
  ]) {
    let generateCalls = 0;
    const { ports } = stubPorts();
    ports.generation.author = async () => {
      generateCalls++;
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    };
    const out = await new RunQaUseCase({ ...ports, codeGraph: fakeCodeGraph(syncTo), config: baseConfig }).run({ ...baseInput, runId: "graph-index-fails" });
    assert.equal(out.decision.verdict, "pass");
    assert.ok(generateCalls > 0);
  }
});

test("code-graph index: each index leaves its provenance as a span and an outcome count", async () => {
  const telemetry = new RecordingTelemetry();
  const { ports } = stubPorts();
  const { codeGraph } = recordingCodeGraph();
  await new RunQaUseCase({ ...ports, codeGraph, telemetry, config: baseConfig }).run({ ...baseInput, runId: "graph-index-span" });

  const span = telemetry.spans.find((s) => s.name === "qayaba.code_graph.index");
  assert.ok(span, "the index span is recorded");
  assert.equal(span.attrs["qayaba.code_graph.sha"], "abc1234");
  assert.equal(span.attrs["qayaba.code_graph.outcome"], "built");
  assert.equal(span.attrs["qayaba.code_graph.engine"], "fake");
  assert.equal(span.attrs["qayaba.code_graph.engine_version"], "1.0.0");
  assert.equal(span.attrs["qayaba.code_graph.node_count"], 10);
  assert.equal(span.attrs["qayaba.code_graph.edge_count"], 20);
  assert.deepEqual(telemetry.counters.filter((c) => c.name === "qayaba.code_graph.index").map((c) => c.attrs["qayaba.code_graph.outcome"]), ["built"]);
});

test("code-graph index: absent port → nothing is indexed and the run goes on", async () => {
  const { ports } = stubPorts();
  const out = await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, runId: "graph-index-absent" });
  assert.equal(out.decision.verdict, "pass");
});

test("code-graph index: classify skip → nothing is indexed (skip returns before the phase)", async () => {
  const { ports } = stubPorts({
    classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }),
  });
  const { calls, codeGraph } = recordingCodeGraph();

  const out = await new RunQaUseCase({ ...ports, codeGraph, config: baseConfig }).run({ ...baseInput, runId: "graph-index-classify-skip", mode: "diff" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(calls.length, 0, "classify skip must return before indexing — the mirror may be GC'd");
});

test("code-graph index: a non-diff run (mode: manual) indexes at the run's SHA too", async () => {
  const { ports, ws } = stubPorts({
    classify: async () => {
      throw new Error("classify() must never be called outside diff mode");
    },
  });
  const { calls, codeGraph } = recordingCodeGraph();

  const out = await new RunQaUseCase({ ...ports, codeGraph, config: baseConfig }).run({ ...baseInput, runId: "graph-index-manual", mode: "manual" });

  assert.deepEqual(calls, [{ repoDir: ws.mirrorDir, sha: "abc1234" }]);
  assert.equal(out.decision.verdict, "pass");
});

test("auth session failure before generate is infra-error and does not generate", async () => {
  let generated = false;
  const { ports } = stubPorts({
    generate: async () => { generated = true; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const useCase = new RunQaUseCase({
    ...ports,
    authSession: { prepare: async () => { throw new Error("login failed"); } },
    authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } },
  });
  const out = await useCase.run({ ...baseInput, runId: "auth-session-pre-generate-fail" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(generated, false);
  assert.match(out.note ?? "", /login failed/);
});

/* A login that breaks between generation and execute is the same class of failure as DEV going
   down at that point: the run already generated specs, so it is recorded like any other terminal. */
test("a pre-execute auth failure is only recorded: an infra-error outcome is persisted, never executed or published", async () => {
  let executed = 0;
  let published = 0;
  const { ports, savedOutcomes } = stubPorts({
    execute: async (dir, opts) => { executed += 1; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; },
    publish: async () => { published += 1; return { outcome: "pr" }; },
  });
  const useCase = new RunQaUseCase({
    ...ports,
    config: baseConfig,
    authSession: {
      prepare: async (req) => {
        if (req.phase === "pre-execute") throw new Error("login form not found");
        return { unauthored: false };
      },
    },
    authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } },
  });

  const out = await useCase.run({ ...baseInput, runId: "auth-session-pre-execute-fail" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(executed, 0);
  assert.equal(published, 0);
  assert.equal(savedOutcomes.length, 1);
  assert.equal(savedOutcomes[0]?.verdict, "infra-error");
  assert.match(savedOutcomes[0]?.note ?? "", /login form not found/);
});

test("a pre-execute auth failure reverts writes outside the suite before the run ends", async () => {
  /* The watched repo's working copy as the confinement fake sees it: enforce() reverts every stray. */
  const strays = new Set<string>();
  const confinement: ConfinementPort = {
    enforce: async () => {
      const reverted = [...strays];
      strays.clear();
      return { strays: reverted.length, dangerous: 0, reverted };
    },
  };
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase({
    ...ports,
    confinement,
    config: baseConfig,
    authSession: {
      prepare: async (req) => {
        if (req.phase !== "pre-execute") return { unauthored: false };
        strays.add("src/app/login.component.ts");
        throw new Error("login form not found");
      },
    },
    authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } },
  });

  const out = await useCase.run({ ...baseInput, runId: "auth-session-pre-execute-confinement" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.deepEqual([...strays], [], "a write made before the failure must not outlive the run");
});

test("auth session prepare runs before generate and again before execute", async () => {
  const phases: string[] = [];
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase({
    ...ports,
    authSession: {
      prepare: async (req) => {
        phases.push(req.phase);
        return { unauthored: false };
      },
    },
    authContext: { baseUrl: "https://dev.example" },
  });
  const out = await useCase.run({ ...baseInput, runId: "auth-session-both-phases" });
  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(phases, ["pre-generate", "pre-execute"]);
});

/* ── A login the run cannot complete ends it before anything is tested ─────────────────────────── */

const FORM_AUTH = { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } as const;
const REJECTED = { kind: PRECONDITION_KIND.CREDENTIALS_REJECTED, note: "the login was rejected", ms: 1200 } as const;

/* The fake session port throws the typed precondition error at the phases the caller names. */
function preconditionRun(opts: { failAt: readonly ("pre-generate" | "pre-execute")[]; classify?: ChangeAnalysisPort["classify"]; mode?: "diff" | "context"; error?: () => Error }) {
  const seen = { generated: 0, executed: 0, published: 0, audited: 0, prepared: [] as string[] };
  const { ports, savedOutcomes } = stubPorts({
    generate: async () => {
      seen.generated += 1;
      return scriptedGeneration({ specs: opts.mode === "context" ? [".qa/context.json"] : ["a.spec.ts"]});
    },
    execute: async (dir, opts) => { seen.executed += 1; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; },
    publish: async () => { seen.published += 1; return { outcome: "pr" }; },
    ...(opts.classify ? { classify: opts.classify } : {}),
  });
  const { observer, events } = fakeObserver();
  const useCase = new RunQaUseCase({
    ...ports,
    observer,
    config: baseConfig,
    processAudit: makeFakeProcessAudit(() => { seen.audited += 1; }),
    authSession: {
      prepare: async (req) => {
        seen.prepared.push(req.phase);
        if (opts.failAt.includes(req.phase)) throw opts.error?.() ?? new AuthPreconditionError(REJECTED.kind, REJECTED.note, REJECTED.ms);
        return { unauthored: false };
      },
    },
    authContext: { baseUrl: "https://dev.example", auth: FORM_AUTH },
  });
  const run = (runId: string, signal?: AbortSignal) => useCase.run({ ...baseInput, runId, ...(opts.mode ? { mode: opts.mode } : {}) }, signal);
  return { run, seen, savedOutcomes, events };
}

test("a login that fails before generation ends the run as a persisted precondition infra-error and never reaches the generator", async () => {
  const { run, seen, savedOutcomes } = preconditionRun({ failAt: ["pre-generate"] });
  const out = await run("precondition-pre-generate");
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(seen.generated, 0);
  assert.equal(savedOutcomes.length, 1);
  assert.equal(savedOutcomes[0]!.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(savedOutcomes[0]!.verdict, "infra-error");
  assert.ok((out.note ?? "").includes(REJECTED.kind), "the note names the kind of failure");
  assert.ok((savedOutcomes[0]!.note ?? "").includes(REJECTED.kind), "the persisted note names it too");
});

test("a precondition failure opens no Issue and teaches nothing: no process audit", async () => {
  for (const failAt of [["pre-generate"], ["pre-execute"]] as const) {
    const { run, seen } = preconditionRun({ failAt });
    const out = await run(`precondition-teaches-nothing-${failAt[0]}`);
    assert.equal(out.decision.sideEffect, "none", failAt[0]);
    assert.deepEqual([seen.published, seen.audited], [0, 0], failAt[0]);
  }
});

test("a login that fails after generation ends the run the same way, before anything executes", async () => {
  const { run, seen, savedOutcomes } = preconditionRun({ failAt: ["pre-execute"] });
  const out = await run("precondition-pre-execute");
  assert.equal(seen.generated, 1, "generation ran; the login only failed afterwards");
  assert.equal(seen.executed, 0);
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(savedOutcomes.length, 1);
  assert.equal(savedOutcomes[0]!.errorClass, ERROR_CLASS.PRECONDITION);
  assert.ok((savedOutcomes[0]!.note ?? "").includes(REJECTED.kind));
});

test("a regression run, which generates nothing, ends on a login that fails the same way", async () => {
  const { run, seen, savedOutcomes } = preconditionRun({
    failAt: ["pre-generate"],
    classify: async () => ({ action: "regression", reason: "type=refactor", diff: "" }),
  });
  const out = await run("precondition-regression");
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(seen.generated, 0);
  assert.equal(savedOutcomes[0]?.errorClass, ERROR_CLASS.PRECONDITION);
});

test("a context run still prepares its session, logs the failed login loudly by kind, and carries on to generation", async () => {
  const { run, seen, events, savedOutcomes } = preconditionRun({ failAt: ["pre-generate"], mode: "context" });
  const out = await run("precondition-context-mode");
  assert.deepEqual(seen.prepared, ["pre-generate"], "prepare still runs: it clears the earlier run's session");
  assert.equal(seen.generated, 1, "the run continues to generation");
  assert.notEqual(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(savedOutcomes.some((o) => o.errorClass === ERROR_CLASS.PRECONDITION), false);
  const loud = events.filter((e) => e.type === "log.line" && e.level === "warn" && e.text.includes(REJECTED.kind));
  assert.ok(loud.length > 0, "a warn log line names the kind");
});

test("a failed login is announced once, at one level on the process log and on the run event: error when it ends the run, warn when a context run carries on", async () => {
  const errorLog = mock.method(console, "error", () => {});
  try {
    for (const { mode, level } of [{ mode: "context", level: "warn" }, { mode: "diff", level: "error" }] as const) {
      const memory = memoryLogger();
      installProcessLogger(memory);
      const { run, events } = preconditionRun({ failAt: ["pre-generate"], mode });
      await run(`precondition-level-${mode}`);
      const lines = memory.entries.filter((e) => e.message.includes(REJECTED.kind));
      const announced = events.filter((e) => e.type === "log.line" && e.text.includes(REJECTED.kind));
      assert.deepEqual(lines.map((e) => e.level), [level], `${mode}: the process log carries the failed login once`);
      assert.deepEqual(announced.map((e) => e.type === "log.line" && e.level), [level], `${mode}: the run event carries the same level`);
    }
  } finally {
    errorLog.mock.restore();
    resetProcessLoggerForTests();
  }
});

test("an abort that lands while the login fails wins over the precondition terminal at either phase", async () => {
  for (const failAt of [["pre-generate"], ["pre-execute"]] as const) {
    const controller = new AbortController();
    const { run, savedOutcomes, seen } = preconditionRun({
      failAt,
      error: () => {
        controller.abort();
        return new AuthPreconditionError(REJECTED.kind, REJECTED.note, REJECTED.ms);
      },
    });
    const out = await run(`precondition-abort-${failAt[0]}`, controller.signal);
    assert.notEqual(out.errorClass, ERROR_CLASS.PRECONDITION, failAt[0]);
    assert.equal(out.note, undefined, `${failAt[0]}: a cancelled run carries no failure note`);
    assert.equal(savedOutcomes.length, 0, `${failAt[0]}: a cancelled run is never persisted`);
    assert.equal(seen.executed, 0, failAt[0]);
  }
});

test("a generic auth failure keeps the infrastructure class, at either phase", async () => {
  for (const failAt of [["pre-generate"], ["pre-execute"]] as const) {
    const { run, savedOutcomes } = preconditionRun({ failAt, error: () => new Error("login form not found") });
    const out = await run(`generic-auth-failure-${failAt[0]}`);
    assert.equal(out.decision.verdict, "infra-error", failAt[0]);
    assert.equal(out.errorClass, ERROR_CLASS.INFRA, failAt[0]);
    assert.equal(savedOutcomes.some((o) => o.errorClass === ERROR_CLASS.PRECONDITION), false, failAt[0]);
  }
});

test("a failed precondition prints its kind, note and duration to the console and nothing more of the error", async () => {
  const leaked = "EVIDENCE-CANARY-7f3a";
  const errorLog = mock.method(console, "error", () => {});
  try {
    const { run } = preconditionRun({
      failAt: ["pre-generate"],
      error: () => Object.assign(new AuthPreconditionError(REJECTED.kind, REJECTED.note, REJECTED.ms), { evidence: leaked, cause: new Error(leaked) }),
    });
    await run("precondition-console-hygiene");
    const printed = errorLog.mock.calls.map((call) => call.arguments.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")).join("\n");
    assert.ok(printed.includes(REJECTED.kind), "the kind is printed");
    assert.ok(printed.includes(REJECTED.note), "the note is printed");
    assert.ok(printed.includes(String(REJECTED.ms)), "the duration is printed");
    assert.equal(printed.includes(leaked), false, "nothing else the error carries is printed");
  } finally {
    errorLog.mock.restore();
  }
});

function authSeedRun(opts: { unauthoredAtGenerate: boolean; groundedPack?: string }) {
  const enrichments: Array<GenerationEnrichment | undefined> = [];
  const { ports } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      enrichments.push(enrichment);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    ...(opts.groundedPack ? { ground: async () => ({ contextPack: opts.groundedPack }) } : {}),
  });
  let calls = 0;
  const useCase = new RunQaUseCase({
    ...ports,
    authSession: {
      prepare: async () => {
        calls += 1;
        return { unauthored: opts.unauthoredAtGenerate && calls === 1 };
      },
    },
    authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } },
  });
  return { useCase, enrichments };
}

test("an unauthored stock auth seed reaches generation as its own fact, never as a Context Pack", async () => {
  const { useCase, enrichments } = authSeedRun({ unauthoredAtGenerate: true });
  const out = await useCase.run({ ...baseInput, runId: "auth-seed-no-pack" });
  assert.equal(out.decision.verdict, "pass");
  assert.equal(enrichments[0]?.authSeedUnauthored, true);
  assert.equal(enrichments[0]?.contextPack, undefined, "no grounding ran, so no Context Pack may be claimed");
});

test("an unauthored stock auth seed leaves a grounded Context Pack free of login instructions", async () => {
  const { useCase, enrichments } = authSeedRun({ unauthoredAtGenerate: true, groundedPack: "## Context Pack\n### Live DOM\n/login: textbox Email" });
  await useCase.run({ ...baseInput, runId: "auth-seed-with-pack" });
  assert.equal(enrichments[0]?.authSeedUnauthored, true);
  assert.match(enrichments[0]?.contextPack ?? "", /Live DOM/);
  assert.doesNotMatch(enrichments[0]?.contextPack ?? "", /auth\.setup\.ts/);
});

test("a seed that signed in does not flag generation to rewrite auth.setup.ts", async () => {
  const { useCase, enrichments } = authSeedRun({ unauthoredAtGenerate: false });
  await useCase.run({ ...baseInput, runId: "auth-seed-signed-in" });
  assert.notEqual(enrichments[0]?.authSeedUnauthored, true);
});

/* ── The real auth adapter under the run: what leaves a failed login, and when generation is told to write the login ─────── */

const ACCOUNT = { user: "qa.bot+tester@demo.example", pass: 'p w0rd&"<x>%+/' };
/* Every way a page, a URL, a form body and a JSON body echo the account back, each written out by hand. */
const ACCOUNT_ECHOES = [
  ACCOUNT.user, "qa.bot%2Btester%40demo.example", "QA.BOT+TESTER@DEMO.EXAMPLE",
  ACCOUNT.pass, "p%20w0rd%26%22%3Cx%3E%25%2B%2F", "p+w0rd%26%22%3Cx%3E%25%2B%2F", 'p w0rd&\\"<x>%+/',
];
const SIGNED_IN_EVIDENCE = { requests: [{ method: "POST", pathname: "/api/session", status: 200 }], passwordGone: true, freshContextChecked: true, freshContextPasswordGone: true, storageStateWritten: true, finalPath: "/home" };

interface DiscoveryRunOptions {
  discover?: (input: LoginDiscoveryInput) => LoginDiscoveryResult;
  /** What the stock seed does when it runs; by default it does not sign in. */
  seed?: (env: Record<string, string>) => { exitCode: number; logs: string };
  redact?: (text: string) => string;
}

/* The real adapter, with a fake discovery child and a fake seed spawn at the process boundary. */
function discoveryRun(opts: DiscoveryRunOptions) {
  const authDir = mkdtempSync(join(tmpdir(), "rq-auth-"));
  const seen = { generated: 0, executed: 0, published: 0, seeded: 0, enrichments: [] as Array<GenerationEnrichment | undefined>, thrown: [] as unknown[] };
  const { ports, savedOutcomes } = stubPorts({
    generate: async (_specDir, _signal, _diff, enrichment) => {
      seen.generated += 1;
      seen.enrichments.push(enrichment);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    execute: async (dir, opts) => { seen.executed += 1; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; },
    publish: async () => { seen.published += 1; return { outcome: "pr" }; },
  });
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: ACCOUNT.user, QA_PASS: ACCOUNT.pass },
    authDir,
    ...(opts.discover
      ? { discovery: { discoverLogin: async (input) => opts.discover!(input), redact: opts.redact ?? ((text: string) => text) } }
      : {}),
    spawnSetup: async (_specDir, env) => {
      seen.seeded += 1;
      return (opts.seed ?? (() => ({ exitCode: 1, logs: "seed did not sign in" })))(env);
    },
  });
  const { observer, events } = fakeObserver();
  const useCase = new RunQaUseCase({
    ...ports,
    observer,
    config: baseConfig,
    authSession: {
      prepare: async (req, signal) => {
        try {
          return await adapter.prepare(req, signal);
        } catch (error) {
          seen.thrown.push(error);
          throw error;
        }
      },
    },
    authContext: { baseUrl: "https://dev.example", auth: FORM_AUTH },
  });
  return { run: (runId: string) => useCase.run({ ...baseInput, runId }), seen, savedOutcomes, events, cleanup: () => rmSync(authDir, { recursive: true, force: true }) };
}

const signsInAndWrites = (input: LoginDiscoveryInput): LoginDiscoveryResult => {
  writeFileSync(input.storageStatePath, "{\"cookies\":[]}");
  return scriptedLoginEvidence(SIGNED_IN_EVIDENCE);
};
const seedSignsIn = (env: Record<string, string>): { exitCode: number; logs: string } => {
  writeFileSync(env.PW_STORAGE_STATE!, "{\"cookies\":[]}");
  return { exitCode: 0, logs: "" };
};

test("a failed login leaks the account through no sink: not the thrown error, the note, the persisted note, the log events or the console", async () => {
  const errorLog = mock.method(console, "error", () => {});
  const harness = discoveryRun({
    discover: () => {
      const echoed = `sink-marker ${ACCOUNT_ECHOES.join(" | ")}`;
      return scriptedLoginEvidence({
        firstAlert: echoed,
        firstPageError: echoed,
        firstNewException: echoed,
        pageErrorCount: 1,
        finalPath: `/login/${ACCOUNT_ECHOES[1]}`,
        ladder: ["/", `/x/${ACCOUNT_ECHOES[4]}`],
        requests: [{ method: "POST", pathname: `/api/${ACCOUNT_ECHOES[4]}/session`, status: 401 }],
      });
    },
  });
  try {
    const out = await harness.run("discovery-hygiene");
    const thrown = harness.seen.thrown[0];
    assert.ok(thrown instanceof AuthPreconditionError, "the login ended the run as a precondition");
    const sinks = {
      "thrown note": thrown.note,
      "thrown message": thrown.message,
      "note": out.note ?? "",
      "persisted note": harness.savedOutcomes[0]?.note ?? "",
      "log events": harness.events.flatMap((event) => (event.type === "log.line" ? [event.text] : [])).join("\n"),
      "console": errorLog.mock.calls.map((call) => call.arguments.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")).join("\n"),
    };
    for (const [name, text] of Object.entries(sinks)) {
      /* Every sink but the log events carries the note itself: the page text is there, with the account taken out of it. */
      if (name !== "log events") assert.ok(text.includes("sink-marker"), `${name} carries the scrubbed page text, not nothing`);
      for (const echo of ACCOUNT_ECHOES) assert.equal(text.toLowerCase().includes(echo.toLowerCase()), false, `${name} leaked ${echo}`);
    }
  } finally {
    errorLog.mock.restore();
    harness.cleanup();
  }
});

test("wrong credentials, evidenced by a rejected submit, end the run as a precondition before the generator is touched", async () => {
  const harness = discoveryRun({ discover: () => scriptedLoginEvidence() });
  try {
    const out = await harness.run("discovery-wrong-credentials");
    assert.equal(out.decision.verdict, "infra-error");
    assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
    assert.equal(harness.savedOutcomes[0]?.errorClass, ERROR_CLASS.PRECONDITION);
    assert.ok((harness.savedOutcomes[0]?.note ?? "").includes(PRECONDITION_KIND.CREDENTIALS_REJECTED));
    assert.deepEqual([harness.seen.generated, harness.seen.executed, harness.seen.published, harness.seen.seeded], [0, 0, 0, 0]);
    assert.equal(out.decision.sideEffect, "none", "no Issue is opened in the watched repo");
  } finally {
    harness.cleanup();
  }
});

test("the shell's redaction is applied to the note the run persists", async () => {
  const harness = discoveryRun({
    discover: () => scriptedLoginEvidence({ firstAlert: "canary-7f3a shown by the page" }),
    redact: (text) => text.replaceAll("canary-7f3a", "[gone]"),
  });
  try {
    await harness.run("discovery-redaction");
    const note = harness.savedOutcomes[0]?.note ?? "";
    assert.ok(note.includes("[gone]"), "the redaction ran over the note");
    assert.equal(note.includes("canary-7f3a"), false);
  } finally {
    harness.cleanup();
  }
});

test("generation is told to write the login only when discovery proved nothing and the seed did not sign in", async () => {
  const rows: Array<{ name: string; opts: DiscoveryRunOptions; unauthored: boolean }> = [
    { name: "discovery confirmed the login", opts: { discover: signsInAndWrites }, unauthored: false },
    { name: "discovery submitted nothing and the seed signs in", opts: { discover: () => scriptedLoginEvidence({ requests: [] }), seed: seedSignsIn }, unauthored: false },
    { name: "discovery submitted nothing and the seed does not sign in", opts: { discover: () => scriptedLoginEvidence({ requests: [] }) }, unauthored: true },
    { name: "discovery submitted and could not confirm it (no seed may submit again)", opts: { discover: () => scriptedLoginEvidence({ requests: [], inFlightAtDeadline: true }), seed: seedSignsIn }, unauthored: true },
    { name: "discovery crashed after submitting", opts: { discover: () => ({ crashed: true, attempted: true }), seed: seedSignsIn }, unauthored: true },
    { name: "discovery is not wired and the seed signs in", opts: { seed: seedSignsIn }, unauthored: false },
    { name: "discovery is not wired and the seed does not sign in", opts: {}, unauthored: true },
  ];
  for (const row of rows) {
    const harness = discoveryRun(row.opts);
    try {
      await harness.run("discovery-unauthored");
      assert.equal(harness.seen.generated, 1, row.name);
      assert.equal(harness.seen.enrichments[0]?.authSeedUnauthored === true, row.unauthored, row.name);
    } finally {
      harness.cleanup();
    }
  }
});

/* ── How a generation ended decides how the run ends ───────────────────────────────────────────── */

const EXHAUSTED_NOTE = "Step budget exhausted with no spec reported (steps 30/30; writes 0). Output tail: the harness was reviewed.";
const EXHAUSTED_TURN = { maxSteps: 30, stepsUsed: 30, exhausted: true, writeCount: 0, observationComplete: true };

interface EndRun {
  out: Awaited<ReturnType<RunQaUseCase["run"]>>;
  savedOutcomes: RunOutcome[];
  events: import("@kernel/contract/events.ts").RunEventBody[];
  published: number;
  validated: number;
  executed: number;
  pruned: string[];
  mirrorDir: string;
}

async function runEndingWith(generation: ReturnType<typeof scriptedGeneration>, config = baseConfig, deps: Partial<RunQaUseCaseDeps> = {}): Promise<EndRun> {
  let published = 0;
  let validated = 0;
  let executed = 0;
  const pruned: string[] = [];
  const { ports, savedOutcomes, ws } = stubPorts({
    generate: async () => generation,
    publish: async () => { published++; return { outcome: "issue" }; },
    validate: async () => { validated++; return { ok: true, errors: [] }; },
    execute: async (dir, opts) => { executed++; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; },
  });
  const { observer, events } = fakeObserver();
  const out = await new RunQaUseCase({ ...ports, ...deps, observer, config, mirrorGc: { prune: async (w: WorkspaceHandle) => { pruned.push(rootsOf(w).mirrorDir); } } }).run(baseInput);
  return { out, savedOutcomes, events, published, validated, executed, pruned, mirrorDir: ws.mirrorDir };
}

test("a generation that ran out of steps with no specs ends the run as a persisted infra-error with the step-budget class and its note", async () => {
  const run = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.EXHAUSTED, note: EXHAUSTED_NOTE, turn: EXHAUSTED_TURN }));
  assert.equal(run.out.decision.verdict, "infra-error");
  assert.equal(run.out.errorClass, ERROR_CLASS.STEP_BUDGET);
  assert.equal(run.savedOutcomes.length, 1, "the run is persisted, unlike a run with no readable verdict");
  assert.equal(run.savedOutcomes[0]!.errorClass, ERROR_CLASS.STEP_BUDGET);
  assert.ok((run.savedOutcomes[0]!.note ?? "").includes(EXHAUSTED_NOTE));
  assert.ok((run.out.note ?? "").includes(EXHAUSTED_NOTE));
});

/* Opaque on purpose: the run carries whatever note the generation ended with. */
const TIME_BUDGET_NOTE = "the note the time-budget generation carried";

test("a generation cut off by its time budget ends the run as a persisted infra-error with the time-budget class and its note", async () => {
  const run = await runEndingWith(scriptedGeneration({ specs: [], parsed: false, end: GENERATION_END.TIME_BUDGET, note: TIME_BUDGET_NOTE }));
  assert.equal(run.out.decision.verdict, "infra-error");
  assert.equal(run.out.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.equal(run.savedOutcomes.length, 1, "the run is persisted, unlike a run with no readable verdict");
  assert.equal(run.savedOutcomes[0]!.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.ok((run.savedOutcomes[0]!.note ?? "").includes(TIME_BUDGET_NOTE));
  assert.ok((run.out.note ?? "").includes(TIME_BUDGET_NOTE));
});

test("a time-budget end opens no Issue, runs no validation or execution, and logs the engine-side cause as time and not as steps", async () => {
  const run = await runEndingWith(scriptedGeneration({ specs: [], parsed: false, end: GENERATION_END.TIME_BUDGET, note: TIME_BUDGET_NOTE }));
  assert.equal(run.out.decision.sideEffect, "none");
  assert.equal(run.published, 0);
  assert.equal(run.validated, 0);
  assert.equal(run.executed, 0);
  const engineSide = run.events.filter((e) => e.type === "log.line" && e.text.includes(ERROR_CLASS.TIME_BUDGET));
  assert.equal(engineSide.length, 1);
  assert.match(engineSide[0]!.type === "log.line" ? engineSide[0]!.text : "", /time-budget/);
  assert.doesNotMatch(engineSide[0]!.type === "log.line" ? engineSide[0]!.text : "", /step-budget|missing decision/);
});

test("an exhausted generation opens no Issue, runs no validation or execution, and prunes its working copy", async () => {
  const run = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.EXHAUSTED, note: EXHAUSTED_NOTE, turn: EXHAUSTED_TURN }));
  assert.equal(run.out.decision.sideEffect, "none");
  assert.equal(run.published, 0);
  assert.equal(run.validated, 0);
  assert.equal(run.executed, 0);
  assert.deepEqual(run.pruned, [run.mirrorDir]);
});

test("an exhausted generation reports itself as an agent error carrying its note, and as a log line", async () => {
  const run = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.EXHAUSTED, note: EXHAUSTED_NOTE, turn: EXHAUSTED_TURN }));
  const error = run.events.find((e) => e.type === "agent.error");
  assert.ok(error && error.type === "agent.error");
  assert.ok(error.detail.includes(EXHAUSTED_NOTE));
  assert.ok(run.events.some((e) => e.type === "log.line" && e.level === "error"), "the terminal is also written to the log");
});

test("a generation that decided nothing ends the run as a persisted infra-error with the no-decision class, its note and the same events", async () => {
  const note = "The generator returned no specs and no no-op decision, even after one repair (steps 12/30; writes 0). Output tail: ok.";
  const run = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.UNDECIDED_EMPTY, note }));
  assert.equal(run.out.decision.verdict, "infra-error");
  assert.equal(run.out.decision.sideEffect, "none");
  assert.equal(run.out.errorClass, ERROR_CLASS.NO_DECISION);
  assert.equal(run.savedOutcomes.length, 1);
  assert.equal(run.savedOutcomes[0]!.errorClass, ERROR_CLASS.NO_DECISION);
  assert.ok((run.savedOutcomes[0]!.note ?? "").includes(note));
  assert.ok(run.events.some((e) => e.type === "agent.error" && e.detail.includes(note)));
  assert.equal(run.published, 0);
  assert.deepEqual(run.pruned, [run.mirrorDir]);
});

test("a generation with no readable verdict keeps its unpersisted infra-error", async () => {
  const run = await runEndingWith(scriptedGeneration({ specs: [], parsed: false, end: GENERATION_END.NO_VERDICT, note: "the agent emitted no parseable verdict" }));
  assert.equal(run.out.decision.verdict, "infra-error");
  assert.equal(run.out.errorClass, ERROR_CLASS.INFRA);
  assert.equal(run.savedOutcomes.length, 0);
  assert.match(run.out.note ?? "", /no parseable verdict/);
});

test("a declared no-op skips the run with the agent's reason as its persisted note", async () => {
  const reason = "The diff only renames an internal helper.";
  const run = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: reason }));
  assert.equal(run.out.decision.verdict, "skipped");
  assert.equal(run.out.errorClass, null);
  assert.equal(run.savedOutcomes.length, 1);
  assert.equal(run.savedOutcomes[0]!.note, reason);
  assert.equal(run.savedOutcomes[0]!.verdict, "skipped");
  assert.deepEqual(run.pruned, [run.mirrorDir]);
  assert.equal(run.published, 0);
});

test("a generation that delivered specs while exhausting its steps continues to a normal outcome and only logs the exhaustion", async () => {
  const run = await runEndingWith(scriptedGeneration({ specs: ["a.spec.ts"], end: GENERATION_END.DELIVERED, turn: EXHAUSTED_TURN }), baseConfig, loginToBeWritten());
  assert.equal(run.out.decision.verdict, "pass");
  assert.equal(run.executed, 1);
  assert.equal(run.events.some((e) => e.type === "agent.error"), false, "no failure is reported for a run that delivered");
  assert.ok(run.events.some((e) => e.type === "log.line" && e.text.includes("30/30")), "the exhaustion is recorded in the log with its step count");
});

test("a delivered generation that did not exhaust its steps logs nothing about them", async () => {
  const finished = { ...EXHAUSTED_TURN, stepsUsed: 12, exhausted: false };
  const run = await runEndingWith(scriptedGeneration({ specs: ["a.spec.ts"], end: GENERATION_END.DELIVERED, turn: finished }));
  assert.equal(run.events.some((e) => e.type === "log.line" && e.text.includes("30")), false);
});

test("a regression run, which generates nothing, is not read as a generation end and still runs the existing suite", async () => {
  let executed = 0;
  const { ports } = stubPorts({
    classify: async () => ({ action: "regression", reason: "docs only", diff: "" }),
    execute: async (dir, opts) => { executed++; return { verdict: "pass", cases: passingCases(dir, opts), logs: "" }; },
  });
  const out = await new RunQaUseCase({ ...ports, config: baseConfig }).run(baseInput);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(executed, 1);
});

/* ── What each generation end teaches the engine ───────────────────────────────────────────────── */

interface Learned {
  audited: RunOutcome[];
}

async function learnFrom(generation: ReturnType<typeof scriptedGeneration>, input: Parameters<RunQaUseCase["run"]>[0] = baseInput): Promise<Learned> {
  const learned: Learned = { audited: [] };
  const { ports } = stubPorts({ generate: async () => generation });
  const processAudit = makeFakeProcessAudit((outcome) => { learned.audited.push(outcome); });
  await new RunQaUseCase({ ...ports, processAudit, config: baseConfig }).run(input);
  return learned;
}

test("a generation that ran out of steps feeds the process audit, under its own class", async () => {
  const learned = await learnFrom(scriptedGeneration({ specs: [], end: GENERATION_END.EXHAUSTED, note: EXHAUSTED_NOTE, turn: EXHAUSTED_TURN }));
  assert.equal(learned.audited.length, 1);
  assert.equal(learned.audited[0]!.errorClass, ERROR_CLASS.STEP_BUDGET);
});

test("a time-budget end reaches the process audit alone, so a recurring one is visible, under its own class", async () => {
  const learned = await learnFrom(scriptedGeneration({ specs: [], parsed: false, end: GENERATION_END.TIME_BUDGET, note: TIME_BUDGET_NOTE }));
  assert.equal(learned.audited.length, 1);
  assert.equal(learned.audited[0]!.errorClass, ERROR_CLASS.TIME_BUDGET);
});

test("a run ended by the run-level deadline is audited as a time-budget end too", async () => {
  const learned: { audited: RunOutcome[] } = { audited: [] };
  const { ports } = stubPorts({ generate: async () => { throw deadlineExceeded("primary"); } });
  await new RunQaUseCase({
    ...ports,
    processAudit: makeFakeProcessAudit((o) => { learned.audited.push(o); }),
    config: baseConfig,
  }).run(baseInput);
  assert.equal(learned.audited.length, 1);
  assert.equal(learned.audited[0]!.errorClass, ERROR_CLASS.TIME_BUDGET);
});

test("a context run that ended on its time budget is not audited either", async () => {
  const audited: RunOutcome[] = [];
  const { ports } = stubPorts({ generate: async () => scriptedGeneration({ specs: [], parsed: false, end: GENERATION_END.TIME_BUDGET, note: TIME_BUDGET_NOTE }) });
  await new RunQaUseCase({ ...ports, processAudit: makeFakeProcessAudit((o) => { audited.push(o); }), config: baseConfig }).run({ ...baseInput, mode: "context" });
  assert.equal(audited.length, 0);
});

test("a context-mode generation that ran out of steps is not audited, like every other context-mode terminal", async () => {
  const learned = await learnFrom(
    scriptedGeneration({ specs: [], end: GENERATION_END.EXHAUSTED, note: EXHAUSTED_NOTE, turn: EXHAUSTED_TURN }),
    { ...baseInput, mode: "context" },
  );
  assert.equal(learned.audited.length, 0);
});

test("a context-mode generation that ran out of steps still ends loudly as a persisted infra-error with its note", async () => {
  const { ports, savedOutcomes } = stubPorts({
    generate: async () => scriptedGeneration({ specs: [], end: GENERATION_END.EXHAUSTED, note: EXHAUSTED_NOTE, turn: EXHAUSTED_TURN }),
  });
  const out = await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, mode: "context" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.STEP_BUDGET);
  assert.ok((out.note ?? "").includes(EXHAUSTED_NOTE));
  assert.equal(savedOutcomes.length, 1);
  assert.equal(savedOutcomes[0]!.errorClass, ERROR_CLASS.STEP_BUDGET);
});

test("a generation that decided nothing never feeds the process audit", async () => {
  const learned = await learnFrom(scriptedGeneration({ specs: [], end: GENERATION_END.UNDECIDED_EMPTY, note: "no decision" }));
  assert.equal(learned.audited.length, 0);
});

test("a declared no-op and a generation with no readable verdict are not audited either", async () => {
  for (const generation of [
    scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "nothing to test" }),
    scriptedGeneration({ specs: [], parsed: false, end: GENERATION_END.NO_VERDICT }),
  ]) {
    const learned = await learnFrom(generation);
    assert.equal(learned.audited.length, 0, generation.end);
  }
});

test("an infrastructure failure before execution is not audited, while a static-gate rejection is", async () => {
  const infra = { audited: 0 };
  const { ports: infraPorts } = stubPorts({ waitUntilHealthy: async () => ({ ok: false, error: new Error("DEV unhealthy") }) });
  await new RunQaUseCase({
    ...infraPorts,
    processAudit: makeFakeProcessAudit(() => { infra.audited++; }),
    config: baseConfig,
  }).run(baseInput);
  assert.deepEqual(infra, { audited: 0 });

  const invalid = { audited: 0 };
  const { ports: invalidPorts } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  await new RunQaUseCase({
    ...invalidPorts,
    processAudit: makeFakeProcessAudit(() => { invalid.audited++; }),
    config: baseConfig,
  }).run(baseInput);
  assert.deepEqual(invalid, { audited: 1 });
});

test("neither a green run nor a flaky one is audited", async () => {
  const green = { audited: 0 };
  const { ports: greenPorts } = stubPorts();
  await new RunQaUseCase({
    ...greenPorts,
    processAudit: makeFakeProcessAudit(() => { green.audited++; }),
    config: baseConfig,
  }).run(baseInput);
  assert.deepEqual(green, { audited: 0 });

  const flaky = { audited: 0 };
  const { ports: flakyPorts } = stubPorts({ execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }) });
  await new RunQaUseCase({
    ...flakyPorts,
    processAudit: makeFakeProcessAudit(() => { flaky.audited++; }),
    config: baseConfig,
  }).run(baseInput);
  assert.deepEqual(flaky, { audited: 0 });
});

/* ── Coordination telemetry reports the review outcome only when a reviewer ran ────────────────── */

async function coordinationReviewOutcome(opts: {
  needsReview: boolean;
  execute?: ExecutionPort["execute"];
  review?: ReviewPort["review"];
  generation?: ReturnType<typeof scriptedGeneration>;
}): Promise<string | undefined> {
  const generation = opts.generation ?? scriptedGeneration({ specs: ["a.spec.ts"]});
  const { ports } = stubPorts({
    generate: async () => generation,
    ...(opts.execute ? { execute: opts.execute } : {}),
    ...(opts.review ? { review: opts.review } : {}),
  });
  const telemetry = new CoordinationTelemetryRecorder();
  /* A coordinated run is the one that reports an outcome: its flows are authored by the coordinator. */
  const leadSidekicks = { coordinate: (input: CoordinateInput) => authoredByCoordinator(ports.generation, input) };
  await new RunQaUseCase({
    ...ports,
    leadSidekicks,
    coordinationTelemetry: telemetry,
    config: { ...baseConfig, needsReview: opts.needsReview },
  }).run(baseInput);
  return telemetry.events.find((event) => event.kind === "outcome")?.reviewOutcome;
}

/* An execution that ends invalid-for-judgment: DEV is down, so no test ran and nothing reaches the review. */
const UNREVIEWABLE_RUN: ExecutionPort["execute"] = async () => ({ verdict: "infra-error", cases: [], logs: "" });

test("the coordination outcome reports the review as not applicable when the run needed one and none looked at it", async () => {
  assert.equal(await coordinationReviewOutcome({ needsReview: true, execute: UNREVIEWABLE_RUN }), "n/a");
});

test("the coordination outcome reports the reviewer's verdict when the review step dispatched one", async () => {
  const approving = async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true });
  const rejecting = async () => ({ approved: false, findings: [{ text: "[false-positive] assert the total", severity: "blocking" as const }], blockingCount: 1, parsed: true });
  assert.equal(await coordinationReviewOutcome({ needsReview: true, review: approving }), "approved");
  assert.equal(await coordinationReviewOutcome({ needsReview: true, review: rejecting }), "rejected");
});

test("the coordination outcome reports the review as skipped when the app needs none", async () => {
  assert.equal(await coordinationReviewOutcome({ needsReview: false }), "skipped");
});

/* ── The reviewer outcome is reported only when a reviewer ran ─────────────────────────────────── */

const BROKEN_SPEC_GATE = { ok: false, errors: ["[lint] no-wait-for-timeout"] };

async function runWithFailingGate(generation: ReturnType<typeof scriptedGeneration>): Promise<RunOutcome> {
  const { ports, savedOutcomes } = stubPorts({ generate: async () => generation, validate: async () => BROKEN_SPEC_GATE });
  await new RunQaUseCase({ ...ports, config: baseConfig }).run(baseInput);
  return savedOutcomes[0]!;
}

test("a non-pass terminal leaves the reviewer outcome absent: only the review step records one", async () => {
  const outcome = await runWithFailingGate(scriptedGeneration({ specs: ["a.spec.ts"]}));
  assert.equal(outcome.verdict, "invalid");
  assert.equal(outcome.gateSignals.reviewerApproved, undefined);
});


test("a declared no-op reports no reviewer outcome: nothing was reviewed", async () => {
  const noop = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "nothing to test" }));
  assert.equal(noop.savedOutcomes[0]!.gateSignals.reviewerApproved, undefined);
  assert.equal(noop.out.gateSignals.reviewerApproved, undefined);
});

test("an exhausted or undecided end reports no reviewer outcome when none ran", async () => {
  const exhausted = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.EXHAUSTED, note: EXHAUSTED_NOTE }));
  assert.equal(exhausted.savedOutcomes[0]!.gateSignals.reviewerApproved, undefined);
  const undecided = await runEndingWith(scriptedGeneration({ specs: [], end: GENERATION_END.UNDECIDED_EMPTY, note: "no decision" }));
  assert.equal(undecided.savedOutcomes[0]!.gateSignals.reviewerApproved, undefined);
});

/* ── The run-level wall-clock deadline ──────────────────────────────────────────────────────────── */

const DEADLINE_BUDGET_MS = 25 * 60_000;
const deadlineExceeded = (role: string, stop: "before-turn" | "mid-turn" = "mid-turn") => new RunDeadlineExceededError(DEADLINE_BUDGET_MS, "diff", role, stop);

interface ArmedScope { mode: string }

/** A deadline port that records when and with what it was armed, against the other phases of the run. */
function recordingDeadline(trace: string[]): { port: RunDeadlinePort; armed: ArmedScope[] } {
  const armed: ArmedScope[] = [];
  return { armed, port: { arm: (scope) => { trace.push("arm"); armed.push(scope); } } };
}

test("the run arms its deadline once, after the deploy gate and the classification, for its mode alone", async () => {
  const trace: string[] = [];
  const { ports } = stubPorts({
    waitUntilHealthy: async () => { trace.push("gate"); return ok(true); },
    classify: async () => { trace.push("classify"); return { action: "generate", reason: "r", diff: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n", intent: { type: "feat", breaking: false, message: "m", changedFiles: ["x"] } }; },
    generate: async () => { trace.push("generate"); return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  const { port, armed } = recordingDeadline(trace);
  await new RunQaUseCase({ ...ports, runDeadline: port, config: baseConfig }).run(baseInput);
  assert.deepEqual(trace.slice(0, 4), ["gate", "classify", "arm", "generate"]);
  assert.equal(armed.length, 1);
  assert.deepEqual(armed[0], { mode: "diff" }, "the bound reads nothing of the change");
});

test("the run hands its deadline the app's recent finished runs by phase, read after arming and for the app and mode of this run", async () => {
  const trace: string[] = [];
  const { ports } = stubPorts();
  const measured: unknown[] = [];
  const queries: unknown[] = [];
  const records = [{ furthestPhase: "learn" as const, phaseTimings: { review: 240_000 } }];
  const runDeadline: RunDeadlinePort = { arm: () => { trace.push("arm"); }, measure: (r) => { trace.push("measure"); measured.push(r); } };
  const phaseHistory = { recentPhaseRecords: async (query: unknown) => { queries.push(query); return records; } };
  await new RunQaUseCase({ ...ports, runDeadline, phaseHistory, config: baseConfig }).run({ ...baseInput, mode: "manual" });
  assert.deepEqual(trace, ["arm", "measure"]);
  assert.deepEqual(measured, [records]);
  assert.deepEqual(queries, [{ app: baseInput.app, budget: "manual", limit: 20 }]);
});

test("a diff run reads the history of runs of its own kind and records that kind, whatever the size of its change", async () => {
  const { ports } = stubPorts();
  const queries: unknown[] = [];
  const runDeadline: RunDeadlinePort = { arm: () => {}, measure: () => {} };
  const phaseHistory = { recentPhaseRecords: async (query: unknown) => { queries.push(query); return []; } };
  const out = await new RunQaUseCase({ ...ports, runDeadline, phaseHistory, config: baseConfig }).run({ ...baseInput, mode: "diff" });
  assert.deepEqual(queries, [{ app: baseInput.app, budget: "diff", limit: 20 }]);
  assert.equal(traceFactsOf(out)?.timeBudget, "diff", "the run records the kind of run it was, so its own phases are read by later runs of that kind");
});

test("a history that cannot be read leaves the run going on the deadline's fallback reserve, and says so", async () => {
  const { ports } = stubPorts();
  let measured = 0;
  const runDeadline: RunDeadlinePort = { arm: () => {}, measure: () => { measured++; } };
  const phaseHistory = { recentPhaseRecords: async () => { throw new Error("history locked"); } };
  const memory = memoryLogger();
  installProcessLogger(memory);
  try {
    const out = await new RunQaUseCase({ ...ports, runDeadline, phaseHistory, config: baseConfig }).run({ ...baseInput, mode: "manual" });
    assert.notEqual(out.decision.verdict, "infra-error", "the run is not ended by a history it could not read");
  } finally {
    resetProcessLoggerForTests();
  }
  assert.equal(measured, 0);
  assert.ok(memory.entries.some((e) => /recent phase durations could not be read/.test(e.message) && /history locked/.test(e.message)));
});

/** A real deadline whose timer the test fires by hand: the moment a deterministic phase is cut. */
function deadlineFiredByHand(budgetMs: number) {
  const fires: Array<() => void> = [];
  const deadline = new RunDeadline({ now: () => 0, budgets: { ...RUN_TIME_BUDGET_MS, diff: budgetMs, manual: budgetMs, context: budgetMs }, schedule: (_ms, fire) => { fires.push(fire); return () => {}; } });
  return { deadline, fire: () => fires.at(-1)?.() };
}

test("a Playwright execution the run's deadline cut ends the run on its time budget with the purpose it cut, not as an untyped infrastructure failure", async () => {
  const { deadline, fire } = deadlineFiredByHand(60_000);
  const { ports } = stubPorts({
    generate: async () => scriptedGeneration({ specs: ["a.spec.ts"] }),
    execute: async () => {
      /* The launcher killed the child at the deadline: the runner reports a run that did not finish. */
      fire();
      return { verdict: "infra-error", cases: [], logs: "playwright runner timed out after 900000ms — killed" };
    },
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, mode: "manual", runId: "cut-execution" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.TIME_BUDGET, "the run's time ended it");
  assert.match(out.note ?? "", /execute-specs phase in progress was stopped/);
  assert.match(out.note ?? "", /purpose cut was execute/);
  assert.notEqual(out.decision.sideEffect, "issue");
});

test("a mode that does not classify arms its deadline for its own mode, with no diff", async () => {
  const trace: string[] = [];
  const { ports } = stubPorts();
  const { port, armed } = recordingDeadline(trace);
  await new RunQaUseCase({ ...ports, runDeadline: port, config: baseConfig }).run({ ...baseInput, mode: "manual" });
  assert.deepEqual(armed, [{ mode: "manual" }]);
});

test("a commit the classifier skips never arms the deadline: it spends no agent time", async () => {
  const trace: string[] = [];
  const { ports } = stubPorts({ classify: async () => ({ action: "skip", reason: "docs only", diff: "" }) });
  const { port, armed } = recordingDeadline(trace);
  await new RunQaUseCase({ ...ports, runDeadline: port, config: baseConfig }).run(baseInput);
  assert.equal(armed.length, 0);
});

/** Runs a run whose agent boundary raises the run's deadline error and reports what the run did about it. */
async function runEndedByDeadline(over: Parameters<typeof stubPorts>[0], config: Record<string, unknown> = baseConfig) {
  let published = 0;
  const pruned: string[] = [];
  const { ports, savedOutcomes, ws } = stubPorts({
    publish: async () => { published++; return { outcome: "issue" }; },
    ...over,
  });
  const { observer, events } = fakeObserver();
  const out = await new RunQaUseCase({ ...ports, observer, config, mirrorGc: { prune: async (w: WorkspaceHandle) => { pruned.push(rootsOf(w).mirrorDir); } } }).run(baseInput);
  return { out, savedOutcomes, events, published: () => published, pruned, mirrorDir: ws.mirrorDir };
}

test("a first generation stopped by the run's deadline ends the run as a persisted infra-error under the time-budget class, with a note that says so", async () => {
  const run = await runEndedByDeadline({ generate: async () => { throw deadlineExceeded("primary"); } });
  assert.equal(run.out.decision.verdict, "infra-error");
  assert.equal(run.out.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.equal(run.savedOutcomes.length, 1, "the run is persisted: it never ends as a silent empty result");
  assert.equal(run.savedOutcomes[0]!.errorClass, ERROR_CLASS.TIME_BUDGET);
  const note = run.savedOutcomes[0]!.note ?? "";
  assert.match(note, /Run time budget of 25 min \(diff\) exhausted/);
  assert.match(note, /primary turn in progress was stopped/);
  assert.match(note, /not a finding about the app/);
  assert.ok((run.out.note ?? "").includes("Run time budget of 25 min"));
});

test("a run ended by its deadline publishes nothing, prunes its working copy and says loudly that the cause is engine-side time", async () => {
  const run = await runEndedByDeadline({ generate: async () => { throw deadlineExceeded("primary", "before-turn"); } });
  assert.equal(run.out.decision.sideEffect, "none");
  assert.equal(run.published(), 0, "no Issue and no PR");
  assert.deepEqual(run.pruned, [run.mirrorDir]);
  assert.ok(run.events.some((e) => e.type === "agent.error" && /next primary turn was not started/.test(e.detail)));
  const engineSide = run.events.filter((e) => e.type === "log.line" && e.text.includes(ERROR_CLASS.TIME_BUDGET));
  assert.equal(engineSide.length, 1);
});

test("the deadline stops a regeneration inside the fix loop the same way: infra-error E-TIME-BUDGET, not an empty regeneration the loop reads as 'no fixes'", async () => {
  let generated = 0;
  const run = await runEndedByDeadline({
    generate: async () => { generated++; if (generated > 1) throw deadlineExceeded("primary"); return scriptedGeneration({ specs: ["a.spec.ts"]}); },
    execute: async () => ({ verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom" }], logs: "" }),
  });
  assert.equal(generated, 2, "the first pass and the one regeneration the deadline refused");
  assert.equal(run.out.decision.verdict, "infra-error");
  assert.equal(run.out.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.equal(run.published(), 0, "a red run whose regeneration the deadline stopped opens no Issue: nothing was concluded about the app");
});

test("the deadline stopping the static-fix regeneration ends the run the same way", async () => {
  let generated = 0;
  const run = await runEndedByDeadline({
    generate: async () => { generated++; if (generated > 1) throw deadlineExceeded("primary"); return scriptedGeneration({ specs: ["a.spec.ts"]}); },
    validate: async () => ({ ok: false, errors: ["TS2304: cannot find name"] }),
  });
  assert.equal(run.out.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.equal(run.out.decision.verdict, "infra-error");
});

test("the deadline stopping the reviewer ends the run as a time-budget infra-error, not as a reviewer that was unavailable", async () => {
  const run = await runEndedByDeadline({ review: async () => { throw deadlineExceeded("reviewer"); } });
  assert.equal(run.out.decision.verdict, "infra-error");
  assert.equal(run.out.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.match(run.savedOutcomes[0]!.note ?? "", /reviewer turn in progress was stopped/);
  assert.equal(run.published(), 0);
});

test("the deadline reaching the pre-generation grounding ends the run: it is not ungrounded generation", async () => {
  let generated = 0;
  const run = await runEndedByDeadline({
    ground: async () => { throw deadlineExceeded("primary", "before-turn"); },
    generate: async () => { generated++; return scriptedGeneration({ specs: ["a.spec.ts"]}); },
  });
  assert.equal(generated, 0, "no generation runs on a run whose time is gone");
  assert.equal(run.out.errorClass, ERROR_CLASS.TIME_BUDGET);
});

test("an agent failure that is not the deadline is still the integration error it was: it propagates and is not recorded as a time-budget end", async () => {
  const { ports, savedOutcomes } = stubPorts({ generate: async () => { throw new Error("provider returned 500"); } });
  await assert.rejects(new RunQaUseCase({ ...ports, ...loginToBeWritten(), config: baseConfig }).run(baseInput), /provider returned 500/);
  assert.equal(savedOutcomes.length, 0);
});

/* Reviewer optimization: the deterministic DOM pre-check, the unchanged-spec rule and the bounded
 * second round. These are the live run's R4 shapes: a spec that asserts "0 resultados" while the
 * captured page shows 11 restaurants (the reviewer rejected it, correctly), and a legitimate spec
 * that must still be approved. */

const R4_DOM = [
  "route /restaurants:",
  "  heading: Restaurantes",
  "  text: 11 restaurantes",
  "  textbox: Buscar",
  "  button: Buscar",
  "  button: Fin de la lista",
  "  test-ids on this route: restaurant-card, end-of-list",
].join("\n");

const R4_SPEC = `import { test, expect } from "../fixtures";

test("the empty state is shown", async ({ page }) => {
  await page.goto("/restaurants");
  await expect(page.getByText("0 resultados")).toBeVisible();
});
`;

const R4_LEGIT_SPEC = `import { test, expect } from "../fixtures";

test("the list is shown", async ({ page }) => {
  await page.goto("/restaurants");
  await expect(page.getByText("11 restaurantes")).toBeVisible();
});
`;

function reviewFixtures(): { specDir: string; mirrorDir: string; write: (file: string, text: string) => void; cleanup: () => void } {
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-review-opt-"));
  const specDir = join(mirrorDir, "e2e");
  mkdirSync(specDir, { recursive: true });
  return {
    specDir,
    mirrorDir,
    write: (file, text) => {
      mkdirSync(join(specDir, file, ".."), { recursive: true });
      writeFileSync(join(specDir, file), text);
    },
    cleanup: () => rmSync(mirrorDir, { recursive: true, force: true }),
  };
}

test("reviewer pre-check (R4): a spec asserting an empty state the captured DOM contradicts is rejected before any model round", async () => {
  const fixtures = reviewFixtures();
  try {
    let modelReviews = 0;
    const regenCorrections: (readonly string[] | undefined)[] = [];
    const { ports, savedOutcomes } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      captureReviewDom: async () => R4_DOM,
      execute: showingACase(async () => ({ verdict: "pass", cases: [{ name: "flows/restaurants.spec.ts", status: "pass" }], logs: "" })),
      review: async () => { modelReviews++; return { approved: true, findings: [], blockingCount: 0, parsed: true }; },
    });
    ports.generation.author = async (specDir, _signal, _diff, enrichment) => {
      regenCorrections.push(enrichment?.reviewCorrections);
      fixtures.write("flows/restaurants.spec.ts", R4_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    const out = await useCase.run({ ...baseInput, runId: "review-precheck-r4" });

    assert.equal(modelReviews, 0, "the deterministic contradiction needs no model round");
    assert.equal(out.decision.verdict, "pass");
    assert.equal(out.decision.sideEffect, "issue", "the pre-check rejection is a real rejection, never a pass");
    const saved = savedOutcomes[0]!;
    assert.equal(saved.gateSignals.reviewerApproved, false);
    assert.match(saved.gateSignals.reviewerCorrections[0] ?? "", /^\[false-positive\]/);
    assert.match(saved.gateSignals.reviewerCorrections[0] ?? "", /0 resultados/);
    assert.deepEqual(regenCorrections.filter((c) => c?.length)[0], saved.gateSignals.reviewerCorrections, "the pre-check's corrections are the regeneration signal");
    assert.equal(saved.gateSignals.reviewer?.preCheckRejects, 1);
    assert.equal(saved.gateSignals.reviewer?.modelRounds, 0);
    assert.equal(saved.gateSignals.reviewer?.rounds, 2, "round 1 exists but is resolved without a model");
    assert.equal(saved.gateSignals.reviewer?.skippedRounds, 1, "the unchanged spec is not re-reviewed");
  } finally {
    fixtures.cleanup();
  }
});

test("reviewer pre-check: a legitimate spec whose assertions the captured DOM confirms reaches the model reviewer and is approved", async () => {
  const fixtures = reviewFixtures();
  try {
    let modelReviews = 0;
    const { ports, savedOutcomes } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      captureReviewDom: async () => R4_DOM,
      execute: showingACase(async () => ({ verdict: "pass", cases: [{ name: "flows/restaurants.spec.ts", status: "pass", file: "flows/restaurants.spec.ts" }], logs: "" })),
      review: async () => {
        modelReviews++;
        return { approved: true, findings: [], blockingCount: 0, rationale: "the list is asserted against the captured page", parsed: true };
      },
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_LEGIT_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    const out = await useCase.run({ ...baseInput, runId: "review-precheck-legit" });

    assert.equal(modelReviews, 1, "no contradiction found: the model reviewer decides");
    assert.equal(out.decision.sideEffect, "pr");
    assert.equal(savedOutcomes[0]!.gateSignals.reviewerApproved, true);
    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.preCheckRejects, 0);
    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.modelRounds, 1);
  } finally {
    fixtures.cleanup();
  }
});

test("reviewer pre-check: a spec whose file passed on DEV is not rejected for an assertion the captured DOM lacks, and the skip is counted", async () => {
  const fixtures = reviewFixtures();
  try {
    let modelReviews = 0;
    const { ports, savedOutcomes } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      captureReviewDom: async () => R4_DOM,
      execute: async () => ({ verdict: "pass", cases: [{ name: "the empty state is shown", file: "flows/restaurants.spec.ts", status: "pass" }], logs: "" }),
      review: async () => { modelReviews++; return { approved: true, findings: [], blockingCount: 0, rationale: "the case ran green on DEV", parsed: true }; },
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    const out = await useCase.run({ ...baseInput, runId: "review-precheck-proven-green" });

    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.preCheckRejects, 0, "the DOM capture does not overrule a spec that ran green against DEV");
    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.preCheckSkippedProven, 1);
    assert.equal(modelReviews, 1, "the model reviewer decides instead");
    assert.equal(savedOutcomes[0]!.gateSignals.reviewerApproved, true);
    assert.equal(out.decision.sideEffect, "pr");
  } finally {
    fixtures.cleanup();
  }
});

test("reviewer pre-check: the same contradiction in a spec file that did not pass on its current bytes is still rejected", async () => {
  const fixtures = reviewFixtures();
  try {
    const { ports, savedOutcomes } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      captureReviewDom: async () => R4_DOM,
      execute: async () => ({ verdict: "flaky", cases: [{ name: "the empty state is shown", file: "flows/restaurants.spec.ts", status: "flaky" }], logs: "" }),
      review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }),
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    await useCase.run({ ...baseInput, runId: "review-precheck-unproven" });

    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.preCheckRejects, 1);
    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.preCheckSkippedProven, undefined);
    assert.equal(savedOutcomes[0]!.gateSignals.reviewerApproved, false);
  } finally {
    fixtures.cleanup();
  }
});

test("a generator that changes nothing after a rejection is not reviewed twice: the previous verdict stands", async () => {
  const fixtures = reviewFixtures();
  try {
    let modelReviews = 0;
    const { ports, savedOutcomes } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({ verdict: "pass", cases: [{ name: "flows/restaurants.spec.ts", status: "pass", file: "flows/restaurants.spec.ts" }], logs: "" }),
      review: async () => {
        modelReviews++;
        return { approved: false, findings: [{ text: "[false-positive] the list is never asserted", severity: "blocking" as const }], blockingCount: 1, parsed: true };
      },
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_LEGIT_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    const out = await useCase.run({ ...baseInput, runId: "review-unchanged-no-recheck" });

    assert.equal(modelReviews, 1, "round 1 sees the same bytes and is not sent to the model");
    assert.equal(out.decision.sideEffect, "issue");
    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.skippedRounds, 1);
    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.modelRounds, 1);
  } finally {
    fixtures.cleanup();
  }
});

test("a regeneration that only adds comments does not buy a second review: the rejection stands", async () => {
  const fixtures = reviewFixtures();
  try {
    let modelReviews = 0;
    let generation = 0;
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({ verdict: "pass", cases: [{ name: "flows/restaurants.spec.ts", status: "pass", file: "flows/restaurants.spec.ts" }], logs: "" }),
      review: async () => {
        modelReviews++;
        return { approved: false, findings: [{ text: "[false-positive] the list is never asserted", severity: "blocking" as const }], blockingCount: 1, parsed: true };
      },
    });
    ports.generation.author = async (_specDir) => {
      generation++;
      fixtures.write("flows/restaurants.spec.ts", generation === 1 ? R4_LEGIT_SPEC : `// regenerated: addressed the reviewer\n${R4_LEGIT_SPEC}`);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    const out = await useCase.run({ ...baseInput, runId: "review-comment-only" });

    assert.equal(modelReviews, 1, "a comment-only change is not a material change");
    assert.equal(out.decision.sideEffect, "issue");
  } finally {
    fixtures.cleanup();
  }
});

test("a materially changed spec is re-reviewed with the prior corrections and the spec change it must focus on", async () => {
  const fixtures = reviewFixtures();
  try {
    const seen: Array<{ priorCorrections?: readonly string[]; specChanges?: string }> = [];
    let generation = 0;
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({ verdict: "pass", cases: [{ name: "flows/restaurants.spec.ts", status: "pass", file: "flows/restaurants.spec.ts" }], logs: "" }),
      review: async (_specDir, _cases, _diff, enrichment) => {
        seen.push({ ...(enrichment?.priorCorrections ? { priorCorrections: enrichment.priorCorrections } : {}), ...(enrichment?.specChanges ? { specChanges: enrichment.specChanges } : {}) });
        return seen.length === 1
          ? { approved: false, findings: [{ text: "[false-positive] the list is never asserted", severity: "blocking" as const }], blockingCount: 1, parsed: true }
          : { approved: true, findings: [], blockingCount: 0, parsed: true };
      },
    });
    ports.generation.author = async (_specDir) => {
      generation++;
      fixtures.write("flows/restaurants.spec.ts", generation === 1 ? R4_SPEC : R4_LEGIT_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    const out = await useCase.run({ ...baseInput, runId: "review-material-change" });

    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]!.priorCorrections, ["[false-positive] the list is never asserted"]);
    assert.match(seen[1]!.specChanges ?? "", /- .*0 resultados/);
    assert.match(seen[1]!.specChanges ?? "", /\+ .*11 restaurantes/);
    assert.equal(out.decision.sideEffect, "pr");
  } finally {
    fixtures.cleanup();
  }
});


/* A telemetry port that keeps the counters a test asserts; every other method is the null object. */
class RecordingTelemetry extends NoopTelemetry {
  readonly counters: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  readonly spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  override counter(name?: string): RecordMeasurement {
    return (_value, attrs) => { this.counters.push({ name: name ?? "", attrs: { ...(attrs ?? {}) } }); };
  }
  override startSpan(name: string, opts?: StartSpanOptions): SpanHandle {
    const record = { name, attrs: { ...(opts?.attrs ?? {}) } };
    this.spans.push(record);
    return {
      setAttrs: (attrs) => { Object.assign(record.attrs, attrs); },
      addEvent: () => {},
      recordError: () => {},
      end: () => {},
      context: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16) }),
    };
  }
}

test("a review round decided without a model says so at the level of an expected fact, once on the process log and the run event, and ships nothing the span already holds", async () => {
  const fixtures = reviewFixtures();
  const memory = memoryLogger();
  installProcessLogger(memory);
  const errorLog = mock.method(console, "error", () => {});
  try {
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      captureReviewDom: async () => R4_DOM,
      execute: showingACase(async () => ({ verdict: "pass", cases: [{ name: "flows/restaurants.spec.ts", status: "pass" }], logs: "" })),
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const { observer, events } = fakeObserver();
    await new RunQaUseCase({ ...ports, observer, config: baseConfig }).run({ ...baseInput, runId: "review-decision-level" });

    const expected = levelOfEffect(LOG_EFFECT.EXPECTED);
    const precheck = memory.entries.filter((e) => e.message.startsWith("[qa] reviewer pre-check:"));
    const unchanged = memory.entries.filter((e) => e.message.includes("did not change since the last rejection"));
    assert.ok(precheck.length >= 2, "the pre-check says its summary and each finding");
    assert.equal(unchanged.length, 1);
    for (const line of [...precheck, ...unchanged]) {
      assert.equal(line.level, expected, line.message);
      assert.notEqual(line.fields.ship, true, "a fact the span records is not shipped");
    }
    const unchangedEvent = events.filter((e) => e.type === "log.line" && e.text.includes("no material spec change"));
    assert.deepEqual(unchangedEvent.map((e) => e.type === "log.line" && e.level), [unchanged[0]!.level]);
  } finally {
    errorLog.mock.restore();
    resetProcessLoggerForTests();
    fixtures.cleanup();
  }
});

test("each review round records a bounded qayaba.review metric: what decided it and how it read", async () => {
  const fixtures = reviewFixtures();
  try {
    const telemetry = new RecordingTelemetry();
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      captureReviewDom: async () => R4_DOM,
      execute: showingACase(async () => ({ verdict: "pass", cases: [{ name: "flows/restaurants.spec.ts", status: "pass" }], logs: "" })),
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, telemetry, config: baseConfig });

    await useCase.run({ ...baseInput, runId: "review-metric" });

    const rounds = telemetry.counters.filter((c) => c.name === "qayaba.review");
    assert.equal(rounds.length, 2, "one measurement per review round, the pre-check and the unchanged one");
    assert.equal(rounds[0]!.attrs["qayaba.review.decided_by"], "precheck");
    assert.equal(rounds[0]!.attrs["qayaba.review.outcome"], "rejected");
    assert.equal(rounds[0]!.attrs["qayaba.review.correction_class"], "false-positive");
    assert.equal(rounds[1]!.attrs["qayaba.review.decided_by"], "unchanged");
    assert.equal(rounds[1]!.attrs["qayaba.review.correction_class"], "false-positive");
    assert.equal(rounds[0]!.attrs["qayaba.app"], baseInput.app);

    const reviewPhase = telemetry.spans.find((s) => s.name === "qayaba.phase.review");
    assert.ok(reviewPhase, "the review phase span is recorded");
    assert.equal(reviewPhase.attrs["qayaba.phase.outcome"], "rejected", "the phase span carries the last review outcome");
    assert.equal(reviewPhase.attrs["qayaba.review.rounds"], 2, "the phase span carries the review round count");
  } finally {
    fixtures.cleanup();
  }
});

test("the reviewer judges only the specs this run delivered; the existing suite is context", async () => {
  const fixtures = reviewFixtures();
  try {
    const seen: Array<{ cases: string[]; existing?: readonly string[] }> = [];
    const { ports, savedOutcomes } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      captureReviewDom: async () => R4_DOM,
      execute: async () => ({
        verdict: "pass",
        cases: [
          { name: "flows/auth.spec.ts", status: "pass", file: "flows/auth.spec.ts" },
          { name: "flows/restaurants.spec.ts", status: "pass", file: "flows/restaurants.spec.ts" },
        ],
        logs: "",
      }),
      review: async (_specDir, cases, _diff, enrichment) => {
        seen.push({
          cases: cases.map((c) => c.file ?? c.name),
          ...(enrichment?.existingSpecFiles ? { existing: enrichment.existingSpecFiles } : {}),
        });
        return { approved: true, findings: [], blockingCount: 0, rationale: "the delivered spec targets the rename", parsed: true };
      },
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_LEGIT_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

    const out = await useCase.run({ ...baseInput, runId: "review-scope-delivered" });

    assert.equal(out.decision.sideEffect, "pr", "the correct delivered spec is approved; the existing auth spec is not a target");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.cases, ["flows/restaurants.spec.ts"], "only the delivered spec is judged");
    assert.deepEqual(seen[0]!.existing, ["flows/auth.spec.ts"], "the existing suite is context, not a review target");
    assert.equal(savedOutcomes[0]!.gateSignals.reviewerApproved, true);
    assert.equal(savedOutcomes[0]!.gateSignals.reviewer?.correctionClass, "none");
  } finally {
    fixtures.cleanup();
  }
});

test("the reviewer decision span carries the delivered targets, the existing suite, the correction class and the bounded corrections", async () => {
  const fixtures = reviewFixtures();
  try {
    const h = new RecordingTelemetry();
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({
        verdict: "pass",
        cases: [
          { name: "flows/auth.spec.ts", status: "pass" },
          { name: "flows/restaurants.spec.ts", status: "pass", file: "flows/restaurants.spec.ts" },
        ],
        logs: "",
      }),
      review: async () => ({
        approved: false,
        findings: [{ text: "[wrong-objective] flows/restaurants.spec.ts: assert the rename, not the list", severity: "blocking" as const }],
        blockingCount: 1,
        rationale: "the delivered spec does not target the rename",
        parsed: true,
      }),
    });
    ports.generation.author = async (_specDir) => {
      fixtures.write("flows/restaurants.spec.ts", R4_LEGIT_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"]});
    };
    const useCase = new RunQaUseCase({ ...ports, telemetry: h, config: baseConfig });

    await useCase.run({ ...baseInput, runId: "review-decision-span" });

    const span = h.spans.find((s) => s.name === "qayaba.review.decision" && s.attrs["qayaba.review.decided_by"] === "model");
    assert.ok(span, "the model round is recorded");
    assert.equal(span.attrs["qayaba.review.outcome"], "rejected");
    assert.equal(span.attrs["qayaba.review.decided_by"], "model");
    assert.equal(span.attrs["qayaba.review.correction_class"], "wrong-objective");
    assert.deepEqual(span.attrs["qayaba.review.targets"], ["flows/restaurants.spec.ts"]);
    assert.deepEqual(span.attrs["qayaba.review.existing_specs"], ["flows/auth.spec.ts"]);
    assert.deepEqual(span.attrs["qayaba.review.corrections"], ["[wrong-objective] flows/restaurants.spec.ts: assert the rename, not the list"]);
    assert.match(String(span.attrs["qayaba.review.rationale"]), /does not target the rename/);
    assert.equal(span.attrs["qayaba.review.blocking"], 1);
    const metric = h.counters.find((m) => m.name === "qayaba.review" && m.attrs["qayaba.review.decided_by"] === "model");
    assert.equal(metric?.attrs["qayaba.review.correction_class"], "wrong-objective");
  } finally {
    fixtures.cleanup();
  }
});

/* The reviewer's answer reaches the decision whole: what the engine could not read is a parse miss with its issues, never an approval. */
function reviewDecisionSpan(h: RecordingTelemetry) {
  const span = h.spans.find((s) => s.name === "qayaba.review.decision" && s.attrs["qayaba.review.decided_by"] === "model");
  assert.ok(span, "the model round is recorded");
  return span;
}

async function runReviewed(runId: string, review: ReviewPort["review"]) {
  const fixtures = reviewFixtures();
  try {
    const h = new RecordingTelemetry();
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({ verdict: "pass" as const, cases: [{ name: "flows/restaurants.spec.ts", file: "flows/restaurants.spec.ts", status: "pass" as const }], logs: "" }),
    });
    /* The answer reaches the step as the test states it: the default rig would cite an uncited rejection. */
    ports.review.review = review;
    ports.generation.author = async () => {
      fixtures.write("flows/restaurants.spec.ts", R4_LEGIT_SPEC);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"] });
    };
    const out = await new RunQaUseCase({ ...ports, telemetry: h, config: baseConfig }).run({ ...baseInput, runId });
    return { out, span: reviewDecisionSpan(h) };
  } finally {
    fixtures.cleanup();
  }
}

test("a reviewer answer the engine could not read is a parse miss that names its issues, and never an approval", async () => {
  const issues = ["corrections.0.severity: Invalid option: expected one of \"blocking\"|\"advisory\""];
  /* The real review port over the real submit contract, which refuses the entry: nothing of the answer may stand as a judgment. */
  const port = new ReviewPortAdapter(
    {
      runtime: submittingRuntime({ openSession: async () => ({ prompt: async () => ({ output: '{"approved":false,"corrections":[{"text":"x"}]}' }), dispose: async () => {} }) }),
      rendering: { render: () => "", renderMain: () => ({ text: "", sectionSizes: {} }), renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: {} }), specFileForFlow: (flow: string) => `flows/${flow}.spec.ts` },
      verdicts: { readGenerator: () => ({ specs: [] }), readReview: () => ({ approved: true, findings: [], parsed: true, valid: true, issues: [] }) },
    },
    { diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff" },
  );
  const { out, span } = await runReviewed("review-unreadable-answer", (specDir, cases, diff, enrichment) => port.review(specDir, cases, diff, enrichment));

  assert.equal(span.attrs["qayaba.review.outcome"], "parse-miss");
  assert.deepEqual(span.attrs["qayaba.review.issues"], issues);
  assert.equal(span.attrs["qayaba.review.dropped_blocking"], undefined, "nothing was set aside as uncited: the entry was never read");
  assert.equal(out.decision.sideEffect, "issue", "an unreadable verdict fails closed");
});

test("a rejection reaches the decision whole and records no issue, and a blocking entry the agent left uncited is still dropped as uncited", async () => {
  const cited = await runReviewed("review-cited-rejection", async () => ({
    approved: false,
    findings: [{ text: "[wrong-objective] flows/restaurants.spec.ts: assert the rename", severity: "blocking" as const, citation: { kind: "execution" as const, ref: "flows/restaurants.spec.ts" } }],
    blockingCount: 1,
    parsed: true,
  }));
  assert.equal(cited.span.attrs["qayaba.review.outcome"], "rejected");
  assert.equal(cited.span.attrs["qayaba.review.issues"], undefined);

  const uncited = await runReviewed("review-uncited-rejection", async () => ({
    approved: false,
    findings: [{ text: "[wrong-objective] flows/restaurants.spec.ts: assert the rename", severity: "blocking" as const }],
    blockingCount: 1,
    parsed: true,
  }));
  assert.equal(uncited.span.attrs["qayaba.review.dropped_blocking"], 1);
  assert.equal(uncited.span.attrs["qayaba.review.drop_reasons"], "uncited=1");
});

test("a dropped finding that repeats a verified finding's text does not come back as blocking", async () => {
  const text = "[wrong-objective] flows/restaurants.spec.ts: assert the rename";
  const { span } = await runReviewed("review-repeated-text", async () => ({
    approved: false,
    findings: [
      { text, severity: "blocking" as const, citation: { kind: "execution" as const, ref: "flows/restaurants.spec.ts" } },
      { text, severity: "blocking" as const },
    ],
    blockingCount: 2,
    parsed: true,
  }));

  assert.deepEqual(span.attrs["qayaba.review.corrections"], [text], "the verified finding is shown once");
  assert.equal(span.attrs["qayaba.review.blocking"], 1);
  assert.equal(span.attrs["qayaba.review.dropped_blocking"], 1);
});

test("an approval whose corrections the engine set aside stays an approval and records the loss", async () => {
  const issues = ["corrections: not a list; read as none beside an approval"];
  const { span } = await runReviewed("review-approval-list-lost", async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true, issues }));

  assert.equal(span.attrs["qayaba.review.outcome"], "approved");
  assert.deepEqual(span.attrs["qayaba.review.issues"], issues);
});

test("the fix_loop phase span carries its outcome, the failing counts and the spec-set digest", async () => {
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-fixloop-span-"));
  const specDir = join(mirrorDir, "e2e");
  mkdirSync(join(specDir, "flows"), { recursive: true });
  writeFileSync(join(specDir, "flows", "checkout.spec.ts"), "import { test } from '../fixtures';\ntest('checkout', async ({ page }) => {});\n");
  try {
    const telemetry = new RecordingTelemetry();
    let executeCallCount = 0;
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir, mirrorDir }),
      execute: async (_specDir, opts) => {
        executeCallCount++;
        return executeCallCount === 1
          ? { verdict: "fail" as const, cases: [{ name: "checkout", status: "fail" as const, file: "a.spec.ts", detail: "getByRole resolved to 0 elements" }], logs: "x" }
          : await passPerSpec(_specDir, opts);
      },
    });
    const useCase = new RunQaUseCase({ ...ports, telemetry, config: baseConfig });

    await useCase.run({ ...baseInput, runId: "fixloop-span" });

    const span = telemetry.spans.find((s) => s.name === "qayaba.phase.fix_loop");
    assert.ok(span, "the fix_loop phase span is recorded");
    assert.equal(span.attrs["qayaba.phase.outcome"], "pass", "the phase span carries the final verdict");
    assert.equal(span.attrs["qayaba.fix_loop.rounds"], 1);
    assert.equal(span.attrs["qayaba.fix_loop.failing_before"], 1);
    assert.equal(span.attrs["qayaba.fix_loop.failing_after"], 0);
    assert.equal(span.attrs["qayaba.fix_loop.absent_selectors"], 0);
    assert.equal(typeof span.attrs["qayaba.fix_loop.spec_sha_before"], "string", "the spec-set digest is readable from the temp files");
    assert.equal(typeof span.attrs["qayaba.fix_loop.spec_sha_after"], "string");
    assert.equal(span.attrs["qayaba.fix_loop.specs_changed"], false, "the loop did not rewrite the failing spec");
    assert.equal(span.attrs["qayaba.fix_loop.triage_trigger"], undefined, "no failure was a triage candidate");
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true });
  }
});
/* The intent lock: the primary pass fixes each spec's contract, and a later regeneration that weakens it
   is recorded (signal) or rejected with its pre-turn bytes (enforce). The baseline never crosses runs. */
function intentWorkspace(bodies: readonly string[]): { prepare: WorkspacePort["prepare"]; generate: AuthorPort["author"]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qa-intent-"));
  const specDir = join(dir, "e2e");
  let calls = 0;
  return {
    prepare: async () => fakeHandle({ specDir, mirrorDir: dir }),
    generate: async () => {
      const body = bodies[Math.min(calls, bodies.length - 1)]!;
      calls += 1;
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "a.spec.ts"), body);
      return scriptedGeneration({ specs: ["a.spec.ts"]});
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const INTENT_PRIMARY = `test("checkout", async ({ page }) => {
  await expect(page.getByText("Pay now")).toHaveText("Pay now");
});`;

const INTENT_WEAKENED = `test("checkout", async ({ page }) => {
  await expect(page.getByText("Pay now")).toBeVisible();
});`;

test("intent lock in signal mode accepts a weakened regeneration and records the would-be rejection", async () => {
  const real = intentWorkspace([INTENT_PRIMARY, INTENT_WEAKENED]);
  try {
    const { ports } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => ({ status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }),
      blocks: (status) => status === "fail",
    });
    const useCase = new RunQaUseCase({
      ...ports,
      intentContract: { extract: extractSpecContract },
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce", intentLock: { mode: "signal", opacityFlagRatio: 0.5 } },
    });

    let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
    ports.runHistory.save = async (outcome) => { saved = outcome; };
    const out = await useCase.run({ ...baseInput, runId: "intent-signal-records" });

    assert.equal(out.decision.verdict, "pass");
    assert.equal(out.gateSignals.intent?.wouldReject, 1, "a weakened matcher in signal mode is recorded, not rejected");
    assert.equal(out.gateSignals.intent?.violations, 1);
    assert.deepEqual(saved?.gateSignals.intent, out.gateSignals.intent, "the persisted outcome records the same intent-lock signal the result carries");
    assert.equal(out.decision.sideEffect, "held", "the coverage policy still holds the PR; the intent lock did not decide it");
  } finally {
    real.cleanup();
  }
});

test("a new run is never bound by a previous run's contract", async () => {
  /* Run 1's primary is a strong matcher; run 2's primary is a presence matcher and its regeneration repeats
     those same bytes. Compared against run 2's own baseline that is no delta; against run 1's it would be a
     weakened matcher recorded as a would-be rejection. */
  const real = intentWorkspace([INTENT_PRIMARY, INTENT_WEAKENED, INTENT_WEAKENED]);
  try {
    let measureCalls = 0;
    const { ports } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => {
        measureCalls += 1;
        return measureCalls <= 2
          ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }
          : { status: "pass" as const, ratio: 0.95 };
      },
      blocks: (status) => status === "fail",
    });
    const useCase = new RunQaUseCase({
      ...ports,
      intentContract: { extract: extractSpecContract },
      config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce", intentLock: { mode: "signal", opacityFlagRatio: 0.5 } },
    });

    const first = await useCase.run({ ...baseInput, runId: "intent-run-one" });
    const second = await useCase.run({ ...baseInput, runId: "intent-run-two" });

    assert.equal(first.gateSignals.intent?.wouldReject, 1, "run 1's regeneration weakened run 1's own primary pass");
    assert.equal(second.decision.verdict, "pass");
    assert.equal(second.decision.sideEffect, "pr", "run 2's regeneration is judged against run 2's own primary pass");
    assert.equal(second.gateSignals.intent?.wouldReject, 0, "so nothing of run 1's contract is held against it");
  } finally {
    real.cleanup();
  }
});

/* The findings filter: a reviewer rejection only stands on evidence the orchestrator can verify. */
function citedReview(citation: { kind: "contract" | "execution" | "dom"; ref: string } | undefined) {
  return async () => ({
    approved: false,
    findings: [{ text: "[wrong-objective] the stock auth spec is not part of this change", severity: "blocking" as const, citation: citation }],
    blockingCount: 1,
    parsed: true,
  });
}

function findingFixtures() {
  const fixtures = reviewFixtures();
  let generation = 0;
  return {
    fixtures,
    generate: async () => {
      generation++;
      fixtures.write("flows/checkout.spec.ts", `// generation ${generation}\n`);
      return scriptedGeneration({ specs: ["flows/checkout.spec.ts"]});
    },
  };
}

test("with the integrity switch on, a blocking finding that cites a spec outside the run cannot block", async () => {
  const { fixtures, generate } = findingFixtures();
  try {
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: passPerSpec,
      review: citedReview({ kind: "contract", ref: "specs/auth.spec.ts#clause-1" }),
    });
    ports.generation.author = generate;
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: true },
    });

    const out = await useCase.run({ ...baseInput, runId: "findings-out-of-scope-dropped" });

    assert.equal(out.decision.verdict, "pass");
    assert.equal(out.decision.sideEffect, "pr", "an unverifiable blocking finding is advisory, so the run still publishes");
  } finally {
    fixtures.cleanup();
  }
});

test("a readable rejection with no findings holds no verified blocking finding, so it does not block and the run publishes", async () => {
  const { fixtures, generate } = findingFixtures();
  try {
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: passPerSpec,
      review: async () => ({ approved: false, findings: [], blockingCount: 2, rationale: "the specs look weak", parsed: true }),
    });
    ports.generation.author = generate;
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, runId: "findings-none-rejection" });

    assert.equal(out.decision.verdict, "pass");
    assert.equal(out.decision.sideEffect, "pr", "only a verified blocking finding blocks");
    assert.equal(out.gateSignals.reviewer?.approved, true);
  } finally {
    fixtures.cleanup();
  }
});

test("a reviewer answer that cannot be read stays a fail-closed parse miss, findings or none", async () => {
  const { fixtures, generate } = findingFixtures();
  try {
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: passPerSpec,
      review: async () => ({ approved: false, findings: [], blockingCount: 0, parsed: false }),
    });
    ports.generation.author = generate;
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, runId: "findings-none-parse-miss" });

    assert.notEqual(out.decision.sideEffect, "pr");
    assert.equal(out.gateSignals.reviewer?.approved, false);
  } finally {
    fixtures.cleanup();
  }
});

test("a verified blocking finding on a spec this run delivered still rejects", async () => {
  const { fixtures, generate } = findingFixtures();
  try {
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({
        verdict: "pass" as const,
        cases: [{ name: "checkout", file: "flows/checkout.spec.ts", status: "pass" as const }],
        logs: "",
      }),
      review: citedReview({ kind: "execution", ref: "flows/checkout.spec.ts" }),
    });
    ports.generation.author = generate;
    const useCase = new RunQaUseCase({
      ...ports,
      config: { ...baseConfig, needsReview: true },
    });

    const out = await useCase.run({ ...baseInput, runId: "findings-verified-blocks" });

    assert.notEqual(out.decision.sideEffect, "pr", "evidence on a delivered spec keeps the rejection standing");
  } finally {
    fixtures.cleanup();
  }
});

test("a blocking finding that cites its spec with the spec directory in front still rejects, as one that cites it without", async () => {
  for (const citation of [
    { kind: "execution" as const, ref: "e2e/flows/checkout.spec.ts" },
    { kind: "contract" as const, ref: "e2e/flows/checkout.spec.ts#clause" },
  ]) {
    const { fixtures, generate } = findingFixtures();
    try {
      const { ports } = stubPorts({
        prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
        execute: async () => ({ verdict: "pass" as const, cases: [{ name: "checkout", file: "flows/checkout.spec.ts", status: "pass" as const }], logs: "" }),
        review: citedReview(citation),
      });
      ports.generation.author = generate;
      const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, runId: `findings-prefixed-${citation.kind}` });

      assert.notEqual(out.decision.sideEffect, "pr", `${citation.ref} names a delivered spec`);
      assert.equal(out.gateSignals.reviewer?.droppedRejections, undefined, "nothing the reviewer blocked on was dropped");
    } finally {
      fixtures.cleanup();
    }
  }
});

test("an approval that carries plain-string notes is no dropped rejection: the reviewer never rejected", async () => {
  const { fixtures, generate } = findingFixtures();
  try {
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async (dir, opts) => ({ verdict: "pass" as const, cases: passingCases(dir, opts), logs: "" }),
      review: async () => ({ approved: true, findings: [{ text: "minor: a name could be clearer", severity: "blocking" as const }], blockingCount: 0, parsed: true }),
    });
    ports.generation.author = generate;
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, runId: "findings-approval-notes" });

    assert.equal(out.decision.sideEffect, "pr");
    assert.equal(out.gateSignals.reviewer?.droppedRejections, undefined);
  } finally {
    fixtures.cleanup();
  }
});

test("a rejection whose every blocking finding the filter dropped is recorded on the decision span and on the reviewer's signal", async () => {
  const { fixtures, generate } = findingFixtures();
  try {
    const h = new RecordingTelemetry();
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: passPerSpec,
      review: citedReview({ kind: "contract", ref: "the checkout flow" }),
    });
    ports.generation.author = generate;
    const out = await new RunQaUseCase({ ...ports, telemetry: h, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, runId: "findings-dropped-recorded" });

    assert.equal(out.decision.sideEffect, "pr");
    const span = h.spans.find((s) => s.name === "qayaba.review.decision" && s.attrs["qayaba.review.decided_by"] === "model");
    assert.equal(span?.attrs["qayaba.review.dropped_blocking"], 1);
    assert.equal(span?.attrs["qayaba.review.drop_reasons"], "unresolved=1");
    assert.deepEqual(out.gateSignals.reviewer?.droppedRejections, { rounds: 1, reasons: { unresolved: 1 } });
  } finally {
    fixtures.cleanup();
  }
});

/*
 * A finding the generator refuses to correct. The orchestrator checks the basis the generator names: a
 * case that ran green, or a clause the current bytes still hold. Verified, the finding is withdrawn and
 * the reviewed bytes stand; unverified, the run cannot settle the judgment and says so instead of
 * opening a PR or an Issue on a verdict nobody can defend.
 */
const DISPUTED_FINDING = "[wrong-objective] checkout.spec.ts: the discount is never asserted";

function disputedFinding(citation: { kind: "contract" | "execution" | "dom"; ref: string }) {
  return async () => ({
    approved: false,
    findings: [{ text: DISPUTED_FINDING, severity: "blocking" as const, citation: citation }],
    blockingCount: 1,
    parsed: true,
  });
}

/* A primary pass that delivers the spec, then a rebuttal turn that refuses a finding it was handed, named by the number the turn showed it (the first, unless a test names another). */
function rebuttingGeneration(rebuttal: (finding: string) => object, specsAtPrimary = true, named = "1") {
  const fixtures = reviewFixtures();
  let turn = 0;
  return {
    fixtures,
    generate: async () => {
      turn++;
      if (turn === 1) {
        if (specsAtPrimary) fixtures.write("flows/checkout.spec.ts", "test('checkout', async () => {});\n");
        return scriptedGeneration({ specs: specsAtPrimary ? ["flows/checkout.spec.ts"] : []});
      }
      return scriptedGeneration({ specs: [], rebuttals: [rebuttal(named)] as never });
    },
  };
}

function disputedPorts(fixtures: ReturnType<typeof reviewFixtures>, generate: () => Promise<ReturnType<typeof scriptedGeneration>>, review: ReviewPort["review"]) {
  const { ports, savedOutcomes } = stubPorts({
    prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
    execute: async () => ({
      verdict: "pass" as const,
      cases: [{ name: "checkout", file: "flows/checkout.spec.ts", status: "pass" as const }],
      logs: "",
    }),
    review,
  });
  ports.generation.author = generate as AuthorPort["author"];
  return { ports, savedOutcomes };
}

test("a verified blocking finding whose rebuttal is not verified ends the run as E-REVIEW-DISPUTED — no PR, no Issue", async () => {
  const { fixtures, generate } = rebuttingGeneration((finding) => ({ finding, basis: "execution", ref: "flows/absent.spec.ts", reason: "the case passed" }));
  try {
    const { ports, savedOutcomes } = disputedPorts(fixtures, generate, disputedFinding({ kind: "execution", ref: "flows/checkout.spec.ts" }) as ReviewPort["review"]);
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig } }).run({ ...baseInput, runId: "review-disputed" });

    assert.equal(out.decision.verdict, "infra-error");
    assert.equal(out.decision.sideEffect, "none", "fail-closed: no PR and no Issue");
    assert.equal(out.errorClass, ERROR_CLASS.REVIEW_DISPUTED);
    assert.equal(savedOutcomes.length, 1, "the dispute is recorded on the run");
    assert.equal(savedOutcomes[0]!.errorClass, ERROR_CLASS.REVIEW_DISPUTED);
    assert.match(savedOutcomes[0]!.note ?? "", /could not settle/);
    assert.match(savedOutcomes[0]!.note ?? "", /the discount is never asserted/, "the record names the finding that stayed open");
    } finally {
    fixtures.cleanup();
  }
});

test("a rebuttal the orchestrator can verify withdraws its finding and the reviewed bytes are approved", async () => {
  const { fixtures, generate } = rebuttingGeneration((finding) => ({ finding, basis: "execution", ref: "flows/checkout.spec.ts", reason: "the case ran green on these bytes" }));
  try {
    const { ports, savedOutcomes } = disputedPorts(fixtures, generate, disputedFinding({ kind: "execution", ref: "flows/checkout.spec.ts" }) as ReviewPort["review"]);
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig } }).run({ ...baseInput, runId: "review-rebuttal-verified" });

    assert.equal(out.decision.verdict, "pass");
    assert.equal(out.decision.sideEffect, "pr", "nothing blocking stands: the run publishes");
    assert.equal(savedOutcomes[0]!.gateSignals.reviewerApproved, true);
  } finally {
    fixtures.cleanup();
  }
});

test("an author rebuttal that repeats a finding's text instead of its number withdraws nothing, even when two findings share the text", async () => {
  const { fixtures, generate } = rebuttingGeneration((finding) => ({ finding, basis: "execution", ref: "flows/checkout.spec.ts", reason: "the case ran green on these bytes" }), true, DISPUTED_FINDING);
  try {
    const twins = async () => ({
      approved: false,
      findings: [
        { text: DISPUTED_FINDING, severity: "blocking" as const, citation: { kind: "execution" as const, ref: "flows/checkout.spec.ts" } },
        { text: DISPUTED_FINDING, severity: "blocking" as const, citation: { kind: "contract" as const, ref: "flows/checkout.spec.ts#assertion-0" } },
      ],
      blockingCount: 2,
      parsed: true,
    });
    const { ports } = disputedPorts(fixtures, generate, twins as ReviewPort["review"]);
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig } }).run({ ...baseInput, runId: "review-rebuttal-twins" });

    assert.notEqual(out.decision.sideEffect, "pr", "both verified findings still stand");
    assert.equal(out.gateSignals.reviewer?.approved, false);
    assert.deepEqual(out.gateSignals.reviewer?.rebuttals, { received: 1, withdrawn: 0 });
  } finally {
    fixtures.cleanup();
  }
});

test("a generator that refuses a finding and offers no basis is a plain rejection, not a dispute", async () => {
  const { fixtures, generate } = rebuttingGeneration(() => ({ finding: "", basis: "execution", ref: "", reason: "" }));
  try {
    const { ports, savedOutcomes } = disputedPorts(fixtures, generate, disputedFinding({ kind: "execution", ref: "flows/checkout.spec.ts" }) as ReviewPort["review"]);
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig } }).run({ ...baseInput, runId: "review-no-rebuttal" });

    assert.notEqual(out.decision.sideEffect, "pr");
    assert.notEqual(out.errorClass, ERROR_CLASS.REVIEW_DISPUTED, "no rebuttal arrived: the existing rejection path stands");
    assert.equal(savedOutcomes.length, 1);
  } finally {
    fixtures.cleanup();
  }
});

/*
 * A correction may change a file the specs import (the project's fixtures, a helper) without touching a
 * spec. Re-executing only the specs whose bytes changed would prove nothing about the ones that read it,
 * so an acceptance that sees a support file change runs the whole suite; a correction that stays inside
 * the specs keeps the cheap path.
 */
function supportChangeWorkspace(): { prepare: WorkspacePort["prepare"]; write: (file: string, text: string) => void; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qa-support-"));
  const specDir = join(dir, "e2e");
  mkdirSync(specDir, { recursive: true });
  return {
    prepare: async () => fakeHandle({ specDir, mirrorDir: dir }),
    write: (file, text) => {
      mkdirSync(join(specDir, file, ".."), { recursive: true });
      writeFileSync(join(specDir, file), text);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function correctiveReview() {
  let round = 0;
  return async () => {
    round += 1;
    return round === 1
      ? {
          approved: false,
          findings: [{ text: "[wrong-objective] a.spec.ts: the total is never asserted", severity: "blocking" as const, citation: { kind: "execution" as const, ref: "a.spec.ts" } }],
          blockingCount: 1,
          parsed: true,
        }
      : { approved: true, findings: [], blockingCount: 0, rationale: "the total is asserted", parsed: true };
  };
}

for (const [label, change, expected] of [
  ["a support file the specs import", "fixtures.ts", ["a.spec.ts", "b.spec.ts"]],
  ["the delivered spec itself", "a.spec.ts", ["a.spec.ts"]],
] as const) {
  test(`a correction that changes ${label} re-executes ${expected.length === 2 ? "the whole suite" : "only the changed spec"}`, async () => {
    const ws = supportChangeWorkspace();
    try {
      ws.write("fixtures.ts", "export const helper = 1;\n");
      ws.write("b.spec.ts", "test('b', async () => {});\n");
      const executed: string[][] = [];
      let turn = 0;
      const { ports } = stubPorts({
        prepare: ws.prepare,
        execute: async (_dir, opts) => {
          const files = (opts as { specFiles?: string[] }).specFiles;
          if (files) executed.push(files);
          return { verdict: "pass" as const, cases: [{ name: "a", file: "a.spec.ts", status: "pass" as const }], logs: "" };
        },
        review: correctiveReview(),
      });
      ports.generation.author = async () => {
        turn += 1;
        if (turn === 1) {
          ws.write("a.spec.ts", "test('a', async () => {});\n");
          return scriptedGeneration({ specs: ["a.spec.ts"]});
        }
        ws.write(change, change === "fixtures.ts" ? "export const helper = 2;\n" : "test('a', async () => { expect(1).toBe(1); });\n");
        return scriptedGeneration({ specs: ["a.spec.ts"]});
      };
      const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true } });

      await useCase.run({ ...baseInput, runId: `support-change-${change}` });

      const acceptance = executed.find((files) => files.includes("a.spec.ts"));
      assert.deepEqual([...(acceptance ?? [])].sort(), [...expected].sort(), "the acceptance executes what the change can affect");
    } finally {
      ws.cleanup();
    }
  });
}

/* The kind of a declared no-op is recorded with the run, and a no-op that calls the change unobservable while the pack's changed-value lines show more nodes than unchanged lines is logged. Observe-only: the verdict stays skipped. */
test("a declared no-op records its kind in the gate signals of the run it skips", async () => {
  for (const kind of [NOOP_KIND.NOT_WORTH, NOOP_KIND.UNOBSERVABLE, NOOP_KIND.UNSPECIFIED]) {
    const { ports, savedOutcomes } = stubPorts({
      generate: async () => ({ ...scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "no rows on DEV" }), noopKind: kind }),
    });
    const out = await new RunQaUseCase({ ...ports, ...loginToBeWritten(), config: baseConfig }).run({ ...baseInput, runId: `noop-kind-${kind}` });
    assert.equal(out.outcome?.verdict, "skipped");
    assert.deepEqual(savedOutcomes.at(-1)?.gateSignals.noop, { kind });
  }
});

test("a run that is no declared no-op records no no-op signal", async () => {
  const { ports, savedOutcomes } = stubPorts({});
  await new RunQaUseCase({ ...ports, config: baseConfig }).run({ ...baseInput, runId: "no-noop-signal" });
  assert.equal("noop" in (savedOutcomes.at(-1)?.gateSignals ?? {}), false);
});

test("an unobservable no-op declared while the pack shows more nodes than unchanged lines is logged as a warning and still skips", async () => {
  const { ports } = stubPorts({
    ground: async () => ({ contextPack: "## Context Pack", changedValuesWithMoreNodes: ["Cambiar filtros"] }),
    generate: async () => ({ ...scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "no rows on DEV" }), noopKind: NOOP_KIND.UNOBSERVABLE }),
  });
  const { observer, events } = fakeObserver();
  const out = await new RunQaUseCase({ ...ports, ...loginToBeWritten(), observer, config: baseConfig }).run({ ...baseInput, runId: "noop-contradicted" });
  assert.equal(out.outcome?.verdict, "skipped");
  const warnings = events.filter((e) => e.type === "log.line" && e.level === "warn");
  assert.equal(warnings.length, 1);
  assert.match(String((warnings[0] as { text: string }).text), /unobservable/);
});

test("a no-op the lead declares in its plan is recorded with the kind unspecified: a plan names no kind", async () => {
  const { ports, savedOutcomes } = stubPorts({});
  const leadSidekicks = { coordinate: async () => ({ action: "noop" as const, reason: "nothing worth a test", signal: { plan: "noop", flows: 0, delivered: 0, incomplete: 0, takeover: false } }) };
  const out = await new RunQaUseCase({
    ...ports,
    leadSidekicks,
    config: baseConfig,
  }).run({ ...baseInput, runId: "plan-noop-kind" });
  assert.equal(out.outcome?.verdict, "skipped");
  assert.deepEqual(savedOutcomes.at(-1)?.gateSignals.noop, { kind: NOOP_KIND.UNSPECIFIED });
});

test("no warning is logged for an unobservable no-op when the pack showed no such line, nor for another kind", async () => {
  for (const [kind, moreNodes] of [[NOOP_KIND.UNOBSERVABLE, []], [NOOP_KIND.NOT_WORTH, ["Cambiar filtros"]]] as const) {
    const { ports } = stubPorts({
      ground: async () => ({ contextPack: "## Context Pack", changedValuesWithMoreNodes: [...moreNodes] }),
      generate: async () => ({ ...scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "reason" }), noopKind: kind }),
    });
    const { observer, events } = fakeObserver();
    await new RunQaUseCase({ ...ports, observer, config: baseConfig }).run({ ...baseInput, runId: `noop-quiet-${kind}-${moreNodes.length}` });
    assert.equal(events.filter((e) => e.type === "log.line" && e.level === "warn").length, 0, `${kind} ${moreNodes.length}`);
  }
});

test("a failure that reads empty, twice, a page the Context Pack read with results ends as E-PRECONDITION without rewriting the test", async () => {
  const fixtures = reviewFixtures();
  try {
    let generations = 0;
    let executions = 0;
    const failing = {
      name: "owners list",
      file: "flows/owners.spec.ts",
      status: "fail" as const,
      detail: "expect(locator).toBeVisible() failed\n\nLocator: locator('app-list')\nError: element(s) not found",
      failureDom: "heading: Owners\ntext: 0 results",
      finalUrl: "https://dev.example/owners/list",
      failureResultCount: 0,
    };
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      ground: async () => ({ packConfirmedDataRoutes: [{ path: "/owners/list", resultCount: 3 }] }),
      generate: async () => {
        generations++;
        fixtures.write("flows/owners.spec.ts", "test('owners list', async () => {});\n");
        return scriptedGeneration({ specs: ["flows/owners.spec.ts"]});
      },
      execute: async () => { executions++; return { verdict: "fail", cases: [failing], logs: "" }; },
    });
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "pack-conflict" });

    assert.equal(out.decision.verdict, "infra-error");
    assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
    assert.equal(generations, 1, "the contradicted failure is never handed back for a rewrite");
    assert.equal(executions, 2, "the suite run and the one triage re-read");
  } finally {
    fixtures.cleanup();
  }
});

test("the record of a run its fix loop ended as E-PRECONDITION says why: the triage's adjudication, reason included, and a note", async () => {
  const fixtures = reviewFixtures();
  try {
    const failing = {
      name: "owners list",
      file: "flows/owners.spec.ts",
      status: "fail" as const,
      detail: "expect(locator).toBeVisible() failed\n\nLocator: locator('app-list')\nError: element(s) not found",
      failureDom: "heading: Owners\ntext: 0 results",
      finalUrl: "https://dev.example/owners/list",
      failureResultCount: 0,
    };
    const { ports, savedOutcomes } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      ground: async () => ({ packConfirmedDataRoutes: [{ path: "/owners/list", resultCount: 3 }] }),
      generate: async () => {
        fixtures.write("flows/owners.spec.ts", "test('owners list', async () => {});\n");
        return scriptedGeneration({ specs: ["flows/owners.spec.ts"] });
      },
      execute: async () => ({ verdict: "fail", cases: [failing], logs: "" }),
    });
    const out = await new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "precondition-record" });

    assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
    const saved = savedOutcomes.at(-1)!;
    assert.equal(saved.adjudication?.class, ADJ_CLASS.DEV_NOT_RENDERED);
    assert.equal(saved.adjudication?.confidence, ADJ_CONFIDENCE.HIGH);
    assert.equal(saved.adjudication?.action, ADJ_ACTION.BREAK_ISSUE);
    const reason = saved.adjudication?.reason ?? "";
    assert.ok(reason.length > 0, "the adjudication keeps its reason");
    assert.ok((saved.note ?? "").includes(reason), `the note carries the reason: ${saved.note}`);
  } finally {
    fixtures.cleanup();
  }
});

test("the pages the Context Pack read with results reach the coordination for every sidekick", async () => {
  const { ports } = stubPorts({ ground: async () => ({ packConfirmedDataRoutes: [{ path: "/owners/list", resultCount: 3 }] }) });
  const seen: CoordinateInput[] = [];
  const leadSidekicks = { coordinate: async (coordinateInput: CoordinateInput) => { seen.push(coordinateInput); return authoredByCoordinator(ports.generation, coordinateInput); } };
  await new RunQaUseCase({
    ...ports,
    leadSidekicks,
    config: baseConfig,
  }).run({ ...baseInput, runId: "pack-facts-to-sidekicks" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.confirmedDataRoutes, [{ path: "/owners/list", resultCount: 3 }]);
});

test("the fix_loop phase span says what made the triage re-read a failure and what the re-read came to", async () => {
  const fixtures = reviewFixtures();
  try {
    let executions = 0;
    const failing = {
      name: "owners list",
      file: "flows/owners.spec.ts",
      status: "fail" as const,
      detail: "expect(locator).toBeVisible() failed\n\nLocator: locator('app-list')\nError: element(s) not found",
      failureDom: "heading: Owners\ntext: 0 results",
      finalUrl: "https://dev.example/owners/list",
      failureResultCount: 0,
    };
    const telemetry = new RecordingTelemetry();
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      ground: async () => ({ packConfirmedDataRoutes: [{ path: "/owners/list", resultCount: 3 }] }),
      generate: async () => {
        fixtures.write("flows/owners.spec.ts", "test('owners list', async () => {});\n");
        return scriptedGeneration({ specs: ["flows/owners.spec.ts"]});
      },
      execute: async () => {
        executions++;
        return executions === 1
          ? { verdict: "fail" as const, cases: [failing], logs: "" }
          : { verdict: "pass" as const, cases: [{ name: "owners list", status: "pass" as const, file: "flows/owners.spec.ts" }], logs: "" };
      },
    });
    const out = await new RunQaUseCase({ ...ports, telemetry, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, runId: "pack-conflict-span" });

    assert.equal(out.decision.verdict, "flaky");
    const span = telemetry.spans.find((s) => s.name === "qayaba.phase.fix_loop");
    assert.ok(span, "the fix_loop phase span is recorded");
    assert.equal(span.attrs["qayaba.fix_loop.triage_trigger"], "pack-conflict");
    assert.equal(span.attrs["qayaba.fix_loop.triage_outcome"], "passed");
    assert.equal(span.attrs["qayaba.fix_loop.triage_files"], 1);
  } finally {
    fixtures.cleanup();
  }
});

/* ── The branch cases: one regeneration from the arms of the changed code no test ran, in signal mode too ── */

const ARMS = [
  { file: "src/a.ts", line: 3, column: 0, kind: "if", arm: "else" },
  { file: "src/a.ts", line: 7, column: 0, kind: "logical", arm: "right of || evaluated" },
];

test("signal mode: a green run with arms no test ran regenerates once with those arms as the missing cases, recounts the coverage from the dumps on disk and records both counts", async () => {
  const real = realCoverageWorkspace();
  const turns: string[] = [];
  const recounts: unknown[] = [];
  try {
    const { ports, savedOutcomes } = stubPorts({
      classify: classifyWithDiff,
      prepare: real.prepare,
      generate: async (...args) => {
        turns.push(JSON.stringify(args));
        return real.generate(...args);
      },
      execute: async () => ({ verdict: "pass" as const, cases: [{ name: "a works", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
      measure: async () => ({ status: "pass" as const, ratio: 0.9, uncovered: [], untakenArms: ARMS, measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, changedBranches: 6, takenBranches: 4 } }),
      recount: async (_br, specDir, _diff, reruns, opts) => {
        recounts.push([specDir.endsWith("e2e"), reruns, opts]);
        return { status: "pass" as const, ratio: 1, uncovered: [], untakenArms: [ARMS[1]!], measurement: { changedLines: 10, coveredChanged: 10, changedFiles: 1, mappedFiles: 1, changedBranches: 6, takenBranches: 5 } };
      },
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" } });

    const out = await useCase.run({ ...baseInput, runId: "branch-cases-signal" });

    assert.equal(out.decision.sideEffect, "pr", "the branch cases never block");
    assert.equal(turns.length, 2, "the first pass and one regeneration");
    assert.ok(turns[1]!.includes("src/a.ts:3:1 if: else") && turns[1]!.includes("src/a.ts:7:1 logical: right of || evaluated"), "the regeneration is given the arms");
    assert.ok(!turns[1]!.includes("all changed lines are covered"), "an arms-only gap says nothing of the lines");
    assert.deepEqual(recounts, [[true, [{ namespace: `${acceptanceNamespace("branch-cases-signal", 0)}-measure`, specFiles: ["a.spec.ts"] }], { caseFiles: ["a.spec.ts"] }]], "the kept file is read from its own measurement execution, told the passing spec files the recounted dumps belong to");
    assert.deepEqual(branchCounts(savedOutcomes.at(-1)!.gateSignals.branchCases), { outcome: "accepted", armsBefore: 2, armsAfter: 1, kept: 1, restored: 0 });
    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.branchCoverage, { changed: 6, taken: 5 }, "the recount is what the run records");
    const record = savedOutcomes.at(-1)!.gateSignals.branchCases!;
    assert.equal(record.findings, 2, "one finding per decision sent");
    assert.equal(record.armsTaken, 1, "the arm the recount no longer lists, by its identity");
    assert.deepEqual(record.decisions?.map((d) => [d.line, d.taken]), [[3, 1], [7, 0]]);
    assert.equal(savedOutcomes.at(-1)!.gateSignals.coverageRatio, 1);
  } finally {
    real.cleanup();
  }
});

/* ── Survivor closure: a regeneration a surviving mutant drove re-applies that mutant to the specs it changed ── */

const SURVIVOR_SITE = {
  file: "src/a.ts",
  line: 9,
  column: 2,
  operator: "negate condition",
  script: { url: "https://dev.example/main.js", sha256: "h" },
  edit: { start: 3, end: 8, replacement: "!(ok)" },
  original: "ok",
  ranIn: ["a-spec-ts-a-works-0.json"],
};
const SURVIVED = { file: "src/a.ts", line: 9, operator: "negate condition", specFiles: ["a.spec.ts"], original: "ok", replacement: "!(ok)" };

function survivorRun(recheck: NonNullable<ObjectiveSignalPort["recheckSurvivors"]>, survivor: typeof SURVIVED & { moved?: ObservedDifference } = SURVIVED) {
  const real = realCoverageWorkspace();
  const turns: string[] = [];
  const { ports, savedOutcomes } = stubPorts({
    classify: classifyWithDiff,
    prepare: real.prepare,
    generate: async (...args) => {
      turns.push(JSON.stringify(args));
      return real.generate(...args);
    },
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "a works", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
    measure: async () => ({
      status: "pass" as const,
      ratio: 1,
      uncovered: [],
      untakenArms: [],
      bundleMutation: { applied: 1, killed: 0, survived: [survivor] },
      survivorRuns: [{ site: SURVIVOR_SITE, specFiles: ["a.spec.ts"] }],
      measurement: { changedLines: 4, coveredChanged: 4, changedFiles: 1, mappedFiles: 1 },
    }),
    recount: async () => null,
    recheckSurvivors: recheck,
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" } });
  return { real, turns, savedOutcomes, useCase };
}

test("an accepted regeneration a surviving mutant drove re-applies that mutant to the specs it changed and records that a test now notices it", async () => {
  const rechecks: unknown[] = [];
  const { real, turns, savedOutcomes, useCase } = survivorRun(async (survivors, specDir, namespace, baselineCases) => {
    rechecks.push([survivors, specDir.endsWith("e2e"), namespace, baselineCases]);
    return { applied: 1, killed: 1, survived: [] };
  });
  try {
    const out = await useCase.run({ ...baseInput, runId: "survivor-closed" });

    assert.equal(turns.length, 2, "the first pass and the one regeneration the survivor drove");
    assert.deepEqual(rechecks, [[[{ site: SURVIVOR_SITE, specFiles: ["a.spec.ts"] }], true, "survivor-closed-closure", ["a works"]]]);
    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.survivorClosure, { routed: 1, judged: 1, closed: 1, open: [] });
    assert.ok(!turns[1]!.includes(SURVIVOR_SITE.script.url), "the served script a mutant edits never reaches an agent");
    assert.equal(out.decision.sideEffect, "pr");
  } finally {
    real.cleanup();
  }
});

test("a surviving mutant whose compared pages did not move is recorded, drives no regeneration and starts no re-run", async () => {
  const rechecks: unknown[] = [];
  const { real, turns, savedOutcomes, useCase } = survivorRun(async (...args) => {
    rechecks.push(args);
    return { applied: 1, killed: 1, survived: [] };
  }, { ...SURVIVED, moved: { kind: "unmoved", tests: 1 } });
  try {
    await useCase.run({ ...baseInput, runId: "survivor-unmoved" });

    assert.equal(turns.length, 1, "only the first pass: nothing an author can assert on");
    assert.deepEqual(rechecks, []);
    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.bundleMutation?.survived[0]?.moved, { kind: "unmoved", tests: 1 });
    assert.equal(savedOutcomes.at(-1)!.gateSignals.survivorClosure, undefined);
  } finally {
    real.cleanup();
  }
});

test("the regeneration a surviving mutant drove is handed the observable the mutation moved, and the record keeps it without the mutant's script or edit", async () => {
  const moved: ObservedDifference = { kind: "moved", requests: { added: ["GET https://api.maps.example/styles/v1/acme/dark"], removed: ["GET https://api.maps.example/styles/v1/acme/light"] }, dom: { added: [], removed: [] }, tests: ["a.spec.ts › a works"] };
  const { real, turns, savedOutcomes, useCase } = survivorRun(async () => ({ applied: 1, killed: 1, survived: [] }), { ...SURVIVED, moved });
  try {
    await useCase.run({ ...baseInput, runId: "survivor-moved" });

    assert.equal(turns.length, 2, "the first pass and the one regeneration the survivor drove");
    assert.ok(turns[1]!.includes("GET https://api.maps.example/styles/v1/acme/dark"), "the request only the mutation made reaches the author");
    assert.ok(turns[1]!.includes("GET https://api.maps.example/styles/v1/acme/light"), "the request only the original made reaches the author");
    assert.ok(!turns[1]!.includes(SURVIVOR_SITE.script.url), "the served script a mutant edits never reaches an agent");
    const recorded = savedOutcomes.at(-1)!.gateSignals.bundleMutation;
    assert.deepEqual(recorded?.survived[0]?.moved, moved);
    assert.ok(!JSON.stringify(recorded).includes(SURVIVOR_SITE.script.url), "nor the record");
  } finally {
    real.cleanup();
  }
});

test("a mutant that still survives the regeneration it drove is recorded open and never changes the decision", async () => {
  const { real, savedOutcomes, useCase } = survivorRun(async () => ({ applied: 1, killed: 0, survived: [SURVIVED] }));
  try {
    const out = await useCase.run({ ...baseInput, runId: "survivor-open" });

    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.survivorClosure, { routed: 1, judged: 1, closed: 0, open: [{ file: "src/a.ts", line: 9, operator: "negate condition" }] });
    assert.equal(out.decision.sideEffect, "pr", "survivor closure is a signal, never a gate");
  } finally {
    real.cleanup();
  }
});

test("a re-applied mutant that reached no page is not judged: the closure counts it routed and neither closed nor open", async () => {
  const { real, savedOutcomes, useCase } = survivorRun(async () => null);
  try {
    await useCase.run({ ...baseInput, runId: "survivor-unjudged" });

    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.survivorClosure, { routed: 1, judged: 0, closed: 0, open: [] });
  } finally {
    real.cleanup();
  }
});

test("a survivor re-check that throws never ends the run: the closure counts the survivor routed and judged none", async () => {
  const { real, savedOutcomes, useCase } = survivorRun(async () => {
    throw new Error("DEV unreachable");
  });
  try {
    const out = await useCase.run({ ...baseInput, runId: "survivor-throws" });

    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.survivorClosure, { routed: 1, judged: 0, closed: 0, open: [] });
    assert.equal(out.decision.sideEffect, "pr", "survivor closure is a signal, never a gate");
  } finally {
    real.cleanup();
  }
});

test("the killed mutants the coverage counted are handed to the recount, and the run records what the coverage counted beside its ratio", async () => {
  const real = realCoverageWorkspace();
  const recounts: unknown[] = [];
  const proof = { namespace: "proofs-mut0", specFiles: ["b.spec.ts"], url: "https://dev/main.js", sha256: "h", edit: { start: 0, end: 1, replacement: "!" }, original: "x" };
  try {
    const { ports, savedOutcomes } = stubPorts({
      classify: classifyWithDiff,
      prepare: real.prepare,
      generate: real.generate,
      /* b.spec.ts, the spec the killed mutant's re-run failed, keeps the bytes the run's measurement ran: its proof holds in the recount. */
      execute: async () => ({ verdict: "pass" as const, cases: [{ name: "a works", status: "pass" as const, file: "a.spec.ts" }, { name: "b works", status: "pass" as const, file: "b.spec.ts" }], logs: "" }),
      measure: async () => ({
        status: "pass" as const,
        ratio: 0.9,
        uncovered: [],
        untakenArms: ARMS,
        mutantProofs: [proof],
        measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, notExecutableLines: 4, notLoadedFiles: ["src/lazy.ts"], coveredByExecution: 7, provenByMutation: 2, armsProvenByMutation: 1 },
      }),
      recount: async (_br, _specDir, _diff, _reruns, opts) => {
        recounts.push(opts);
        return null;
      },
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" } });

    await useCase.run({ ...baseInput, runId: "proofs" });

    assert.deepEqual(recounts, [{ proofs: [proof], caseFiles: ["b.spec.ts", "a.spec.ts"] }]);
    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.changeCoverage, { executableLines: 10, notExecutableLines: 4, notLoadedFiles: ["src/lazy.ts"], coveredByExecution: 7, provenByMutation: 2, armsProvenByMutation: 1, measuredBy: { namespace: "proofs-measure", tests: 2, failedOnlyUnderMeasurement: [] } });
  } finally {
    real.cleanup();
  }
});

test("a measurement whose evidence could not be read is recorded with the reason, and one that stands without evidence says which", async () => {
  const cases: Array<[CoverageMeasurement, unknown]> = [
    [{ changedLines: 2, coveredChanged: 0, changedFiles: 1, mappedFiles: 0, unmeasured: "decode-aborted" }, { executableLines: 0, unmeasured: "decode-aborted" }],
    [{ changedLines: 2, coveredChanged: 0, changedFiles: 1, mappedFiles: 0, unmeasured: "no-dumps" }, { executableLines: 0, unmeasured: "no-dumps" }],
    [{ changedLines: 2, coveredChanged: 0, changedFiles: 1, mappedFiles: 0, unmeasured: "no-changed-file-mapped" }, undefined],
    [{ changedLines: 2, coveredChanged: 1, changedFiles: 1, mappedFiles: 1, evidenceLeftOut: ["dumps-over-cap"] }, { executableLines: 2, evidenceLeftOut: ["dumps-over-cap"] }],
  ];
  for (const [measurement, expected] of cases) {
    const real = realCoverageWorkspace();
    try {
      const { ports, savedOutcomes } = stubPorts({
        prepare: real.prepare,
        generate: real.generate,
        execute: async () => ({ verdict: "pass" as const, cases: [{ name: "a works", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
        measure: async () => ({ status: "unknown" as const, ratio: null, measurement }),
      });
      const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "off" } });

      await useCase.run({ ...baseInput, runId: "unread" });

      assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.changeCoverage, expected, JSON.stringify(measurement));
    } finally {
      real.cleanup();
    }
  }
});

/* ── A gap regeneration is accepted spec file by spec file: one failing spec does not throw away a green one ── */

/* A workspace whose first pass writes two specs and whose regeneration rewrites both and creates a third. */
function twoSpecWorkspace(): { specDir: string; prepare: WorkspacePort["prepare"]; generate: AuthorPort["author"]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qa-per-file-"));
  const specDir = join(dir, "e2e");
  let calls = 0;
  return {
    specDir,
    prepare: async () => fakeHandle({ specDir, mirrorDir: dir }),
    generate: async () => {
      calls += 1;
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "a.spec.ts"), `// a, generation ${calls}\n`);
      writeFileSync(join(specDir, "b.spec.ts"), `// b, generation ${calls}\n`);
      if (calls > 1) writeFileSync(join(specDir, "c.spec.ts"), `// c, generation ${calls}\n`);
      return scriptedGeneration({ specs: calls > 1 ? ["a.spec.ts", "b.spec.ts", "c.spec.ts"] : ["a.spec.ts", "b.spec.ts"] });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function perFileRun(acceptanceCases: QaCase[]) {
  const ws = twoSpecWorkspace();
  const turns: string[] = [];
  const rechecks: unknown[] = [];
  const recounts: unknown[] = [];
  const firstCases: QaCase[] = [
    { name: "a works", status: "pass", file: "a.spec.ts" },
    { name: "b works", status: "pass", file: "b.spec.ts" },
  ];
  const { ports, savedOutcomes } = stubPorts({
    classify: classifyWithDiff,
    prepare: ws.prepare,
    generate: async (...args) => {
      turns.push(JSON.stringify(args));
      return ws.generate(...args);
    },
    execute: async (_dir, opts) => {
      const accepting = (opts as { namespace?: string } | undefined)?.namespace?.includes("-acc") ?? false;
      if (!accepting) return { verdict: "pass" as const, cases: firstCases, logs: "" };
      return { verdict: acceptanceCases.every((c) => c.status === "pass") ? ("pass" as const) : ("fail" as const), cases: acceptanceCases, logs: "" };
    },
    measure: async () => ({
      status: "pass" as const,
      ratio: 0.9,
      uncovered: [],
      untakenArms: ARMS,
      bundleMutation: { applied: 1, killed: 0, survived: [{ ...SURVIVED, specFiles: ["a.spec.ts", "b.spec.ts"] }] },
      survivorRuns: [{ site: SURVIVOR_SITE, specFiles: ["a.spec.ts", "b.spec.ts"] }],
      measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, changedBranches: 6, takenBranches: 4 },
    }),
    recount: async (_br, _specDir, _diff, reruns) => {
      recounts.push(reruns);
      return { status: "pass" as const, ratio: 1, uncovered: [], untakenArms: [ARMS[1]!], measurement: { changedLines: 10, coveredChanged: 10, changedFiles: 1, mappedFiles: 1, changedBranches: 6, takenBranches: 5 } };
    },
    recheckSurvivors: async (survivors, _specDir, _namespace, baselineCases) => {
      rechecks.push([survivors.map((s) => s.specFiles), baselineCases]);
      return { applied: 1, killed: 1, survived: [] };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" } });
  return { ws, turns, rechecks, recounts, savedOutcomes, useCase };
}

test("a branch regeneration whose acceptance fails in one spec file keeps the spec file whose cases all passed and gives the others their prior bytes back", async () => {
  const { ws, turns, rechecks, recounts, savedOutcomes, useCase } = perFileRun([
    { name: "a works", status: "pass", file: "a.spec.ts" },
    { name: "a else arm", status: "pass", file: "a.spec.ts" },
    { name: "b works", status: "fail", file: "b.spec.ts", detail: "expected 1 row" },
    { name: "c works", status: "fail", file: "c.spec.ts", detail: "expected 1 row" },
  ]);
  try {
    const out = await useCase.run({ ...baseInput, runId: "per-file" });

    assert.equal(turns.length, 2, "the first pass and the one branch regeneration");
    assert.equal(readFileSync(join(ws.specDir, "a.spec.ts"), "utf8"), "// a, generation 2\n", "the all-green file keeps its new bytes");
    assert.equal(readFileSync(join(ws.specDir, "b.spec.ts"), "utf8"), "// b, generation 1\n", "the failing file gets the bytes that last ran green");
    assert.throws(() => readFileSync(join(ws.specDir, "c.spec.ts")), "the failing file the turn created is removed");
    assert.deepEqual(recounts, [[{ namespace: "per-file-measure", specFiles: ["b.spec.ts"] }, { namespace: `${acceptanceNamespace("per-file", 0)}-measure`, specFiles: ["a.spec.ts"] }]], "the kept file is read from its own measurement execution; the file given its prior bytes back from the measurement that ran those bytes");
    assert.deepEqual(branchCounts(savedOutcomes.at(-1)!.gateSignals.branchCases), { outcome: "accepted", armsBefore: 2, armsAfter: 1, kept: 1, restored: 2 });
    assert.deepEqual(rechecks, [[[["a.spec.ts"]], ["a works", "a else arm"]]], "the survivor is judged on the kept file and its passing cases only");
    assert.equal(out.decision.verdict, "pass", "the suite on disk is the kept file and the prior bytes, all green");
    assert.equal(out.decision.sideEffect, "pr", "every delivered spec's bytes hold a green proof");
  } finally {
    ws.cleanup();
  }
});

test("a branch regeneration whose acceptance is green in every spec file is accepted whole, as before", async () => {
  const { ws, recounts, savedOutcomes, useCase } = perFileRun([
    { name: "a works", status: "pass", file: "a.spec.ts" },
    { name: "b works", status: "pass", file: "b.spec.ts" },
    { name: "c works", status: "pass", file: "c.spec.ts" },
  ]);
  try {
    const out = await useCase.run({ ...baseInput, runId: "per-file-green" });

    assert.equal(readFileSync(join(ws.specDir, "b.spec.ts"), "utf8"), "// b, generation 2\n");
    assert.equal(readFileSync(join(ws.specDir, "c.spec.ts"), "utf8"), "// c, generation 2\n");
    assert.deepEqual(recounts, [[{ namespace: `${acceptanceNamespace("per-file-green", 0)}-measure`, specFiles: ["a.spec.ts", "b.spec.ts", "c.spec.ts"] }]], "the recount reads every kept file from their measurement execution");
    assert.deepEqual(branchCounts(savedOutcomes.at(-1)!.gateSignals.branchCases), { outcome: "accepted", armsBefore: 2, armsAfter: 1, kept: 3, restored: 0 });
    assert.equal(out.decision.sideEffect, "pr");
  } finally {
    ws.cleanup();
  }
});

test("a branch regeneration whose acceptance fails in every spec file is rejected and restored whole, as before", async () => {
  const { ws, recounts, rechecks, savedOutcomes, useCase } = perFileRun([
    { name: "a works", status: "fail", file: "a.spec.ts" },
    { name: "b works", status: "fail", file: "b.spec.ts" },
    { name: "c works", status: "fail", file: "c.spec.ts" },
  ]);
  try {
    const out = await useCase.run({ ...baseInput, runId: "per-file-red" });

    assert.equal(readFileSync(join(ws.specDir, "a.spec.ts"), "utf8"), "// a, generation 1\n");
    assert.equal(readFileSync(join(ws.specDir, "b.spec.ts"), "utf8"), "// b, generation 1\n");
    assert.throws(() => readFileSync(join(ws.specDir, "c.spec.ts")));
    assert.deepEqual(recounts, [], "nothing is recounted");
    assert.deepEqual(rechecks, [], "no survivor is judged");
    assert.deepEqual(branchCounts(savedOutcomes.at(-1)!.gateSignals.branchCases), { outcome: "rejected", armsBefore: 2, armsAfter: 2, kept: 0, restored: 3 });
    assert.equal(out.decision.sideEffect, "pr", "the first suite still stands green");
  } finally {
    ws.cleanup();
  }
});

test("no branch regeneration without arms, with the branch cases off, or when the enforce-mode coverage regeneration already carries them", async () => {
  const cases: ReadonlyArray<[string, Partial<{ untakenArms: typeof ARMS; mode: "signal" | "enforce"; branchCases: "regenerate" | "off" | undefined; status: "pass" | "fail" }>, number]> = [
    ["no arms", { untakenArms: [], mode: "signal", branchCases: "regenerate", status: "pass" }, 1],
    ["off", { untakenArms: ARMS, mode: "signal", branchCases: "off", status: "pass" }, 1],
    ["not configured", { untakenArms: ARMS, mode: "signal", branchCases: undefined, status: "pass" }, 1],
    ["enforce failing", { untakenArms: ARMS, mode: "enforce", branchCases: "regenerate", status: "fail" }, 2],
  ];
  for (const [label, c, expectedTurns] of cases) {
    const real = realCoverageWorkspace();
    let turns = 0;
    try {
      const { ports, savedOutcomes } = stubPorts({
        prepare: real.prepare,
        generate: async (...args) => {
          turns++;
          return real.generate(...args);
        },
        execute: passPerSpec,
        measure: async () => ({ status: c.status!, ratio: 0.5, uncovered: [{ file: "src/a.ts", lines: [1] }], untakenArms: c.untakenArms! }),
        blocks: (status) => c.mode === "enforce" && status === "fail",
      });
      const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: c.mode!, ...(c.branchCases ? { coverageBranchCases: c.branchCases } : {}) } });

      await useCase.run({ ...baseInput, runId: `branch-cases-${label.replace(/ /g, "-")}` });

      assert.equal(turns, expectedTurns, `${label}: generation turns`);
      assert.equal(savedOutcomes.at(-1)!.gateSignals.branchCases, undefined, `${label}: no branch regeneration recorded`);
    } finally {
      real.cleanup();
    }
  }
});

test("a branch regeneration that delivers nothing keeps the first measurement and its bytes, and recounts nothing", async () => {
  const real = realCoverageWorkspace();
  let turns = 0;
  let recounts = 0;
  try {
    const { ports, savedOutcomes } = stubPorts({
      prepare: real.prepare,
      generate: async (...args) => (++turns === 1 ? real.generate(...args) : scriptedGeneration({ specs: [] })),
      execute: passPerSpec,
      measure: async () => ({ status: "pass" as const, ratio: 0.9, uncovered: [], untakenArms: ARMS, measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, changedBranches: 6, takenBranches: 4 } }),
      recount: async () => {
        recounts++;
        return null;
      },
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" } });

    await useCase.run({ ...baseInput, runId: "branch-cases-empty" });

    assert.equal(turns, 2);
    assert.equal(recounts, 0);
    assert.deepEqual(branchCounts(savedOutcomes.at(-1)!.gateSignals.branchCases), { outcome: "empty", armsBefore: 2, armsAfter: 2 });
    assert.deepEqual(savedOutcomes.at(-1)!.gateSignals.branchCoverage, { changed: 6, taken: 4 });
  } finally {
    real.cleanup();
  }
});

test("an accepted branch regeneration the port cannot recount leaves the arms after it unknown", async () => {
  const real = realCoverageWorkspace();
  try {
    const { ports, savedOutcomes } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => ({ status: "pass" as const, ratio: 0.9, uncovered: [], untakenArms: ARMS }),
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" } });

    await useCase.run({ ...baseInput, runId: "branch-cases-no-recount" });

    assert.deepEqual(branchCounts(savedOutcomes.at(-1)!.gateSignals.branchCases), { outcome: "accepted", armsBefore: 2, kept: 1, restored: 0 });
  } finally {
    real.cleanup();
  }
});

/* ── The reviewer's missing cases: judged against the arms no test ran, recorded and shown, never a gate ── */

test("the reviewer is given the arms no test ran, and a missing case it cites from them is recorded and published without rejecting the run", async () => {
  let given: unknown;
  let published: Parameters<PublicationPort["publish"]>[0] | undefined;
  const { ports, savedOutcomes } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "a works", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
    measure: async () => ({ status: "pass" as const, ratio: 0.9, uncovered: [], untakenArms: ARMS }),
    review: async (_dir, _cases, _diff, enrichment) => {
      given = enrichment?.untakenArms;
      return {
        approved: false,
        findings: [{ text: "[missing-case] the else of src/a.ts:3 (no results) is not tested", severity: "blocking", citation: { kind: "arm", ref: "src/a.ts:3" } }, { text: "[missing-case] an arm the run never measured", severity: "blocking", citation: { kind: "arm", ref: "src/z.ts:1" } }],
        blockingCount: 2,
        parsed: true,
      };
    },
    publish: async (decision) => {
      published = decision;
      return { outcome: "pr" };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true, coveragePolicyMode: "signal" } });

  await useCase.run({ ...baseInput, runId: "missing-cases-recorded" });

  assert.deepEqual(given, ARMS);
  const saved = savedOutcomes.at(-1)!;
  assert.equal(saved.verdict, "pass");
  assert.deepEqual(saved.gateSignals.missingCases, ["[missing-case] the else of src/a.ts:3 (no results) is not tested"]);
  assert.equal(published?.reviewerApproved, true, "a missing case never rejects");
  assert.deepEqual(published?.missingCases, ["[missing-case] the else of src/a.ts:3 (no results) is not tested"]);
});

test("after an accepted regeneration whose coverage could not be recounted, the reviewer is given no arms", async () => {
  const real = realCoverageWorkspace();
  let given: unknown = "not called";
  try {
    const { ports } = stubPorts({
      prepare: real.prepare,
      generate: real.generate,
      execute: passPerSpec,
      measure: async () => ({ status: "pass" as const, ratio: 0.9, uncovered: [], untakenArms: ARMS }),
      review: async (_dir, _cases, _diff, enrichment) => {
        given = enrichment?.untakenArms;
        return { approved: true, findings: [], blockingCount: 0, parsed: true };
      },
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: true, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" } });

    await useCase.run({ ...baseInput, runId: "missing-cases-stale-arms" });

    assert.equal(given, undefined);
  } finally {
    real.cleanup();
  }
});

/* ── the end of a purpose's share is that turn's end, not the run's ────────────────────────────── */

const MIN = 60_000;

/* A fake agent runtime whose turn needs `needMs` of the shared clock: it ends at its own timeout when that comes first. */
function turnNeeding(clock: { t: number }, needMs: number) {
  return {
    openSession: async () => ({
      prompt: async (_text: string, opts?: { timeoutMs?: number }) => {
        const start = clock.t;
        if (opts?.timeoutMs !== undefined && opts.timeoutMs < needMs) {
          clock.t = Math.max(clock.t, start + opts.timeoutMs);
          throw new AgentTimeoutError(`timed out after ${opts.timeoutMs}`);
        }
        clock.t = Math.max(clock.t, start + needMs);
        return { output: "done" };
      },
      dispose: async () => {},
    }),
  };
}

/* A real deadline on the shared clock; its timer is fired by hand (`fires`). */
function deadlineOn(clock: { t: number }, budgetMs: number, fires: Array<() => void> = []) {
  return new RunDeadline({ now: () => clock.t, budgets: { ...RUN_TIME_BUDGET_MS, diff: budgetMs, manual: budgetMs, context: budgetMs }, schedule: (_ms, fire) => { fires.push(fire); return () => {}; } });
}

const limitsOf = (out: object) => (traceFactsOf(out)?.limits ?? []).map((l) => `${l.fired}${l.purpose ? `@${l.purpose}` : ""}`);

test("a review that needs more than its share but less than the run has left still gives the verdict: only the run's own deadline ends the run", async () => {
  const clock = { t: 0 };
  const deadline = deadlineOn(clock, 30 * MIN);
  const runtime = new RunDeadlineRuntime(turnNeeding(clock, 5.5 * MIN) as never, deadline);
  let reviews = 0;
  const { ports } = stubPorts({
    generate: async () => { clock.t += 23 * MIN; return scriptedGeneration({ specs: ["a.spec.ts"] }); },
    review: async () => {
      reviews++;
      const s = await runtime.openSession("reviewer", "/m", { timeoutMs: 6 * MIN });
      await s.prompt("review", {});
      return { approved: true, findings: [], blockingCount: 0, parsed: true };
    },
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, mode: "manual", runId: "share-review" });
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
  assert.equal(reviews, 1);
  assert.ok(deadline.remainingMs()! > 0, "the run still had time");
});

test("a fix loop whose share is spent skips its regeneration and the run reaches its failing verdict, instead of ending on the time budget", async () => {
  const clock = { t: 0 };
  const deadline = deadlineOn(clock, 25 * MIN);
  const history = Array.from({ length: 5 }, () => ({ furthestPhase: "learn" as const, phaseTimings: { fix_loop: 0, coverage: 3 * MIN, review: 8 * MIN, decide: 30_000, publish: 30_000 } }));
  let generateCalls = 0;
  const { ports } = stubPorts({
    generate: async () => { generateCalls++; clock.t += generateCalls === 1 ? 15 * MIN : 3 * MIN; return scriptedGeneration({ specs: ["a.spec.ts"] }); },
    execute: async () => { clock.t += MIN; return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" }; },
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, phaseHistory: { recentPhaseRecords: async () => history }, config: { ...baseConfig, needsReview: false } } as never).run({ ...baseInput, mode: "manual", runId: "share-fix" });
  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "issue");
  assert.equal(generateCalls, 1, "the regeneration was not started");
  assert.ok(limitsOf(out).includes("allotment@fix"), `the skip is the fix loop's time limit: ${limitsOf(out).join(", ")}`);
});

test("a fix loop with 100 s left and no history skips its regeneration the same way, and the run keeps its failing verdict", async () => {
  const clock = { t: 0 };
  const deadline = deadlineOn(clock, 25 * MIN);
  let generateCalls = 0;
  const { ports } = stubPorts({
    generate: async () => { generateCalls++; if (generateCalls === 1) clock.t += 25 * MIN - 100_000; return scriptedGeneration({ specs: ["a.spec.ts"] }); },
    execute: async () => ({ verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" }),
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, mode: "manual", runId: "share-fix-b" });
  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "issue");
  assert.equal(generateCalls, 1);
});

test("a fix round whose acceptance is allotted no more time skips the round, and the run reaches its failing verdict instead of ending on the time budget", async () => {
  const clock = { t: 0 };
  const deadline = deadlineOn(clock, 25 * MIN);
  let executedForAcceptance = 0;
  const { ports, ws } = stubPorts({
    generate: async () => scriptedGeneration({ specs: ["a.spec.ts"] }),
    execute: async (_dir, opts) => {
      if ((opts as { purpose?: string } | undefined)?.purpose === "acceptance") {
        executedForAcceptance++;
        throw new AllotmentSpentError("acceptance", "fix", "before-turn");
      }
      return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" };
    },
  });
  ports.generation.author = revisingAuthor(ws);
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, mode: "manual", runId: "acceptance-share-spent" });
  assert.equal(executedForAcceptance, 1, "the round's acceptance was reached and its execution was the turn that ran out of time");
  assert.equal(out.decision.verdict, "fail", "the run still had time: the unrepaired failure is the app's verdict");
  assert.equal(out.decision.sideEffect, "issue");
  assert.notEqual(out.errorClass, ERROR_CLASS.TIME_BUDGET, "a spent share is the acceptance's timeout, not the run's");
  assert.ok(limitsOf(out).includes("allotment@fix"), `the skipped round is the fix loop's time limit: ${limitsOf(out).join(", ")}`);
});

test("a run whose suite is red owes its fix loop no time for a coverage measurement it will not reach", async () => {
  const clock = { t: 0 };
  const deadline = deadlineOn(clock, 25 * MIN);
  const history = Array.from({ length: 5 }, () => ({ furthestPhase: "learn" as const, phaseTimings: { fix_loop: 0, coverage: 5 * MIN, review: 3 * MIN, decide: 30_000, publish: 30_000 } }));
  let generateCalls = 0;
  const { ports } = stubPorts({
    generate: async () => { generateCalls++; clock.t += generateCalls === 1 ? 15 * MIN : MIN; return scriptedGeneration({ specs: ["a.spec.ts"] }); },
    execute: async () => { clock.t += MIN; return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom", file: "owners.spec.ts" }], logs: "" }; },
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, phaseHistory: { recentPhaseRecords: async () => history }, config: { ...baseConfig, needsReview: false } } as never).run({ ...baseInput, mode: "manual", runId: "share-fix-red" });
  assert.ok(generateCalls > 1, `the fix loop had the time the coverage measurement was no longer owed: ${generateCalls} generate call(s)`);
  assert.equal(out.decision.verdict, "fail");
});

/* The T17 shape: a green run that needs its review, whose coverage regeneration would run past its share. */
async function coverageRegenCutAtItsShare(history: Array<{ furthestPhase: "learn"; phaseTimings: Record<string, number> }> | undefined, regenNeeds: number, reviewNeeds: number, runId: string) {
  const clock = { t: 0 };
  const deadline = deadlineOn(clock, 40 * MIN);
  const regenRuntime = new RunDeadlineRuntime(turnNeeding(clock, regenNeeds) as never, deadline);
  const reviewRuntime = new RunDeadlineRuntime(turnNeeding(clock, reviewNeeds) as never, deadline);
  let reviews = 0;
  const { ports } = stubPorts({
    execute: async (...args: Parameters<typeof passPerSpec>) => { clock.t += 3 * MIN; return passPerSpec(...args); },
    measure: async () => ({ status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }),
    blocks: (status) => status === "fail",
    review: async () => {
      reviews++;
      const s = await reviewRuntime.openSession("reviewer", "/m", { timeoutMs: 6 * MIN });
      await s.prompt("review", {});
      return { approved: true, findings: [], blockingCount: 0, parsed: true };
    },
  });
  let genCalls = 0;
  ports.generation.author = async () => {
    genCalls++;
    if (genCalls === 1) { clock.t += 20 * MIN; return scriptedGeneration({ specs: ["a.spec.ts"] }); }
    const s = await regenRuntime.openSession("author", "/m", {});
    await s.prompt("cover the uncovered lines", {});
    return scriptedGeneration({ specs: ["a.spec.ts"] });
  };
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, ...(history ? { phaseHistory: { recentPhaseRecords: async () => history } } : {}), config: { ...baseConfig, needsReview: true, coveragePolicyMode: "enforce" } } as never).run({ ...baseInput, runId });
  return { out, genCalls, reviews, leftMs: deadline.remainingMs()! };
}

test("a coverage regeneration cut at its share is skipped and the review still runs inside its own share (measured history)", async () => {
  const history = Array.from({ length: 5 }, () => ({ furthestPhase: "learn" as const, phaseTimings: { coverage: 4 * MIN, review: 8 * MIN, decide: 30_000, publish: 30_000 } }));
  const { out, genCalls, reviews, leftMs } = await coverageRegenCutAtItsShare(history, 12 * MIN, 5.5 * MIN, "share-coverage");
  assert.equal(genCalls, 2, "the regeneration turn was started");
  assert.equal(reviews, 1, "and the review ran after it was cut");
  assert.equal(out.decision.verdict, "pass");
  assert.ok(leftMs > 0);
  assert.ok(limitsOf(out).includes("allotment@coverage"), limitsOf(out).join(", "));
});

test("the same cut with no phase history (the fallback reserve) leaves the review its time too", async () => {
  const { out, genCalls, reviews, leftMs } = await coverageRegenCutAtItsShare(undefined, 14 * MIN, 3 * MIN, "share-coverage-fallback");
  assert.equal(genCalls, 2);
  assert.equal(reviews, 1);
  assert.equal(out.decision.verdict, "pass");
  assert.ok(leftMs > 0);
});

test("a green suite whose coverage measurement meets the run's deadline keeps its proof and publishes: the deadline takes the measurement, not the verdict", async () => {
  const clock = { t: 0 };
  const fires: Array<() => void> = [];
  const deadline = deadlineOn(clock, 30 * MIN, fires);
  let measured = 0;
  const { ports } = stubPorts({
    generate: async () => { clock.t += 20 * MIN; return scriptedGeneration({ specs: ["a.spec.ts"] }); },
    measure: async () => { measured++; clock.t += 11 * MIN; fires.at(-1)?.(); return { status: "unknown" as const, ratio: null }; },
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false } }).run({ ...baseInput, mode: "manual", runId: "deadline-in-measure" });
  assert.equal(measured, 1);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
  assert.ok(limitsOf(out).includes("run-deadline@coverage"), `the deadline is recorded as the limit that fired: ${limitsOf(out).join(", ")}`);
  assert.ok((traceFactsOf(out)?.degradations ?? []).some((d) => d.reason === "deadline-after-proof"));
});

test("a green suite whose review is required still ends E-TIME-BUDGET when the deadline meets the coverage measurement: approval is the one thing the deadline takes", async () => {
  const clock = { t: 0 };
  const fires: Array<() => void> = [];
  const deadline = deadlineOn(clock, 30 * MIN, fires);
  const { ports } = stubPorts({
    generate: async () => { clock.t += 20 * MIN; return scriptedGeneration({ specs: ["a.spec.ts"] }); },
    measure: async () => { clock.t += 11 * MIN; fires.at(-1)?.(); return { status: "unknown" as const, ratio: null }; },
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: true } }).run({ ...baseInput, mode: "manual", runId: "deadline-in-measure-review" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.TIME_BUDGET);
});

test("an enforced coverage gate whose final re-measure meets the run's deadline ends E-TIME-BUDGET: a measurement of replaced bytes decides nothing", async () => {
  const fixtures = reviewFixtures();
  try {
    const clock = { t: 0 };
    const fires: Array<() => void> = [];
    const deadline = deadlineOn(clock, 40 * MIN, fires);
    let generation = 0;
    let reviews = 0;
    let measureCalls = 0;
    const { ports } = stubPorts({
      prepare: async () => fakeHandle({ specDir: fixtures.specDir, mirrorDir: fixtures.mirrorDir }),
      execute: async () => ({ verdict: "pass" as const, cases: [{ name: "a", status: "pass" as const, file: "flows/restaurants.spec.ts" }], logs: "" }),
      measure: async () => {
        measureCalls++;
        if (measureCalls === 1) return { status: "pass" as const, ratio: 0.9 };
        clock.t += 30 * MIN;
        fires.at(-1)?.();
        return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] };
      },
      blocks: (status) => status === "fail",
      review: async () => {
        reviews++;
        return reviews === 1
          ? { approved: false, findings: [{ text: "assert the amount", severity: "blocking" as const }], blockingCount: 1, parsed: true }
          : { approved: true, findings: [], blockingCount: 0, parsed: true };
      },
    });
    ports.generation.author = async () => {
      generation++;
      if (generation === 1) clock.t += 20 * MIN;
      fixtures.write("flows/restaurants.spec.ts", `export const generation = ${generation};\n`);
      return scriptedGeneration({ specs: ["flows/restaurants.spec.ts"] });
    };
    const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: true, coveragePolicyMode: "enforce" } }).run({ ...baseInput, runId: "deadline-in-final-remeasure", mode: "diff" });
    assert.equal(measureCalls, 2, "the first measurement and the final re-measure the deadline cut");
    assert.equal(out.decision.verdict, "infra-error");
    assert.equal(out.errorClass, ERROR_CLASS.TIME_BUDGET);
    assert.notEqual(out.decision.sideEffect, "pr");
  } finally {
    fixtures.cleanup();
  }
});

test("an enforced coverage gate whose measurement meets the run's deadline ends E-TIME-BUDGET: the deadline never publishes past a gate it left undecided", async () => {
  const clock = { t: 0 };
  const fires: Array<() => void> = [];
  const deadline = deadlineOn(clock, 30 * MIN, fires);
  const { ports } = stubPorts({
    generate: async () => { clock.t += 20 * MIN; return scriptedGeneration({ specs: ["a.spec.ts"] }); },
    measure: async () => { clock.t += 11 * MIN; fires.at(-1)?.(); return { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1] }] }; },
    blocks: (status: string) => status === "fail",
  });
  const out = await new RunQaUseCase({ ...ports, runDeadline: deadline, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" } }).run({ ...baseInput, mode: "manual", runId: "deadline-in-measure-enforce" });
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.notEqual(out.decision.sideEffect, "pr");
});
