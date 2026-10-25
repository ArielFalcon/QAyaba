/* buildProduction wires the run pipeline from the composition config alone.
   buildShadow(cfg) always wires the engine with the SHADOW publication path (no PR/Issue side
   effect) and a read-only history snapshot (no persistence to a real store). This suite supplies
   fake collaborators (repo/mirror/coverage/etc.) rather than booting real git/Playwright/Stryker —
   the composition root's job under test is "does it wire the ports to the right adapter classes",
   not "does a real QA run pass end-to-end".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProduction,
  buildShadow,
  wireAdapters,
  type CompositionConfig,
} from "@contexts/qa-run-orchestration/composition/composition-root.ts";
import { RunPipelineAdapter } from "@contexts/qa-run-orchestration/infrastructure/run-pipeline.adapter.ts";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundaryProfile } from "@contexts/service-topology/domain/index.ts";
import { ok, err } from "@kernel/result.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";

import { GENERATION_END } from "@kernel/generation-end.ts";
import { resolveCoordinationSettings } from "@kernel/coordination.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import { NO_SPEC_SNAPSHOTS } from "@kernel/ports/spec-snapshot.port.ts";
import { TracedCurriculumPort, TracedLearningPort } from "@contexts/qa-run-orchestration/infrastructure/adapters/context-trace.ts";
import { SpecSnapshotValidationPort } from "@contexts/qa-run-orchestration/infrastructure/adapters/spec-snapshot-validation.adapter.ts";
import { TracedSuiteStore } from "@contexts/qa-run-orchestration/infrastructure/adapters/suite-store-trace.ts";
import { SuiteStoreAdapter } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts";
/* ── A minimal fake CompositionConfig — every collaborator is a lightweight stub, matching the
   SAME stub shapes run-pipeline.adapter.test.ts already uses for the 10-scenario parity
   (this test does not re-run that parity; it proves the composition root wires the RIGHT classes).
 */
/*
 * The real working copy and store behind every composed run. The run proves the specs it publishes by hashing real bytes, so
 * this suite cannot hand it a made-up path: the checkout returns a temp mirror that holds the spec its generator delivers.
 */
const COMPOSITION_BASE = mkdtempSync(join(tmpdir(), "qa-composition-"));
const MIRROR = join(COMPOSITION_BASE, "mirror");
mkdirSync(join(MIRROR, "e2e"), { recursive: true });
writeFileSync(join(MIRROR, "e2e", "a.spec.ts"), "// fixture a.spec.ts\n");
const SUITE_STORE = new SuiteStoreAdapter({
  storeDir: join(COMPOSITION_BASE, "suite-store"),
  app: "app",
  repo: "org/app",
  specRelDir: "e2e",
  listTracked: async () => new Map(),
  now: () => new Date(Date.UTC(2026, 0, 1)),
});
process.once("exit", () => rmSync(COMPOSITION_BASE, { recursive: true, force: true }));

function fakeConfig(overrides: Partial<CompositionConfig> = {}): CompositionConfig {
  const base: CompositionConfig = {
    repo: "org/app",
    appName: "app",
    mirrorDir: MIRROR,
    e2eRelDir: "e2e",
    branch: "qa-bot/abc1234",
    target: "e2e",
    mode: "diff",
    needsReview: false,
    shadow: false,
    onFailure: "github-issue",
    maxRetries: 2,
    isCode: false,
    coveragePolicyMode: "signal",

    vcs: {
      blastRadius: async (sha) => BlastRadius.of(sha, ["src/x.ts"]),
      message: async () => "feat: add x",
      diff: async () => "diff --git a/src/x.ts b/src/x.ts",
    },
    generationUseCase: {
      generate: async () => ({ specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED }),
    },
    /* The delivered specs exist nowhere on disk in this suite, which wires ports and reads no files: Lever-2's spec reader is a fake like every other collaborator here. The composition root's own default, the confined reader, is exercised against real files in seam-parity.contract.test.ts. */
    readSpecSource: () => "",
    reviewRuntime: {
      runtime: { openSession: async () => ({ prompt: async () => ({ output: "{}" }), dispose: async () => {} }) },
      rendering: { renderReviewer: () => ({ text: "", sectionSizes: {} }) },
      verdicts: { parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
    },
    validationStrategies: {
      e2e: { validateAll: async () => ({ ok: true, errors: [], infra: false }) },
      code: { validate: async () => ({ ok: true, errors: [], infra: false }) },
    },
    executionStrategies: {
      e2e: { run: async () => ({ verdict: "pass", cases: [], logs: "" }) },
      code: { run: async () => ({ verdict: "pass", cases: [], logs: "" }) },
    },
    objectiveSignal: {
      collector: { collect: async () => ({ covered: [] }) },
      oracle: { measure: async () => ({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" }) },
    },
    coveragePolicy: { mode: "signal", minRatio: 0.7 },
    learningRepo: {
      save: async () => {},
      topRules: async () => [],
      applyOutcome: async () => {},
    },
    checkout: async () => MIRROR,
    suiteStore: SUITE_STORE,
    versionUrl: undefined,
    versionPoll: async () => ({ serving: true }),
    githubPr: { openWithAutoMerge: async () => ({ url: "https://github.com/org/app/pull/1", number: 1 }) },
    githubIssue: { open: async () => ({ url: "https://github.com/org/app/issues/1", number: 1 }) },
    /* PROD-BLOCKER fix: vcsWrite is now REQUIRED for any run this suite drives to the "pr" outcome
       (PublicationPortAdapter's own fail-closed guard throws otherwise — see that file's own header).
       Wired here once, same "one base object feeds every call site" convention as sanitize below.
     */
    vcsWrite: { publish: async () => ({ changed: true }) },
    historyFilePath: "/tmp/qa-run-history.jsonl",
    /* PublicationPortAdapter's sanitize collaborator is now REQUIRED
       (constructor throws if absent — fail-closed publication default). This fake config's ONE base
       object feeds every buildProduction/buildShadow call in this file, so wiring an identity
       sanitizer here once satisfies the constructor guard everywhere without touching the 68 call
       sites individually — this suite's own job (composition wiring) does not exercise sanitization
       content, so identity is the correct fake here.
     */
    sanitize: (text: string) => text,
  };
  return { ...base, ...overrides };
}

/* The review DOM grounding captures the routes of the specs the generator delivered. They are read through the confined reader, and the anchor it holds them to is the run's mirror: wired here from the composition config, so a spec directory that is a real directory but lives outside the mirror yields nothing. */
test("the review DOM grounding reads the delivered specs through the confined reader, anchored on the run's mirror", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-composition-review-dom-"));
  try {
    const mirror = join(dir, "mirror");
    mkdirSync(join(mirror, "e2e"), { recursive: true });
    writeFileSync(join(mirror, "e2e", "ok.spec.ts"), `await page.goto("/ok");`);
    mkdirSync(join(dir, "elsewhere", "e2e"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "e2e", "planted.spec.ts"), `await page.goto("/planted");`);
    symlinkSync(join(dir, "elsewhere"), join(mirror, "hop"));
    const captured: string[][] = [];
    const adapters = wireAdapters(fakeConfig({
      mirrorDir: mirror,
      baseUrl: "https://dev.example.com",
      reviewDomGroundingCollaborators: { captureDom: async (input) => { captured.push([...input.specContents]); return undefined; } },
    }));

    await adapters.reviewDomGrounding!.capture(join(mirror, "e2e"), ["ok.spec.ts"]);
    await adapters.reviewDomGrounding!.capture(join(mirror, "hop", "e2e"), ["planted.spec.ts"]);

    assert.deepEqual(captured, [[`await page.goto("/ok");`], [""]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The pre-exec grounding reads the suite's specs through the confined reader too, anchored on the run's mirror wired from the composition config: a symlinked spec reads as an empty string and its target is not what the capture is given. */
test("the pre-exec grounding reads the suite through the confined reader, anchored on the run's mirror", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-composition-pre-exec-"));
  try {
    const mirror = join(dir, "mirror");
    mkdirSync(join(mirror, "e2e"), { recursive: true });
    writeFileSync(join(mirror, "e2e", "ok.spec.ts"), "// ok");
    writeFileSync(join(dir, "secret.txt"), "TOP SECRET");
    symlinkSync(join(dir, "secret.txt"), join(mirror, "e2e", "leak.spec.ts"));
    mkdirSync(join(dir, "elsewhere", "e2e"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "e2e", "planted.spec.ts"), "// planted");
    symlinkSync(join(dir, "elsewhere"), join(mirror, "hop"));
    const fed: string[][] = [];
    const adapters = wireAdapters(fakeConfig({
      mirrorDir: mirror,
      baseUrl: "https://dev.example.com",
      preExecGroundingCollaborators: { captureRouteTrees: async (input) => { fed.push([...input.specContents]); return []; } },
    }));

    const inside = await adapters.preExecGrounding!.capture(join(mirror, "e2e"));
    const throughSymlinkedParent = await adapters.preExecGrounding!.capture(join(mirror, "hop", "e2e"));

    assert.equal(inside.specSources[inside.specFiles.indexOf("ok.spec.ts")], "// ok");
    assert.equal(inside.specSources[inside.specFiles.indexOf("leak.spec.ts")], "", "a symlink out of the mirror reads as empty");
    assert.deepEqual(throughSymlinkedParent.specSources, [""], "a spec directory that is a real directory outside the mirror reads as empty");
    assert.equal(fed.length, 2, "the capture ran for both suites");
    assert.ok(fed.flat().includes("// ok"), "and was given the spec that is inside");
    assert.ok(!fed.flat().some((source) => source.includes("TOP SECRET") || source.includes("planted")), "but neither of the others");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── buildProduction: wires the run pipeline ───────────────────────────────────────── */

test("buildProduction wires a pipeline from the composition config alone", () => {
  const port = buildProduction(fakeConfig());
  assert.ok(port instanceof RunPipelineAdapter);
});

test("buildProduction drives a full run end-to-end through the 11 wired ports (green-pr shape)", async () => {
  const port = buildProduction(fakeConfig());

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-smoke",
  });

  assert.equal(outcome.verdict, "pass");
});

/* threads cfg.reflectorPort through to RunQaUseCaseDeps.reflector — not just that the config TYPE
   accepts the field. wireAdapters() is not exported, so this drives a real run through the public
   buildProduction() entry point and observes the fake reflector's own call count, exactly the same
   black-box style the "shadow-log publication" test above uses for githubPr/githubIssue. ───────
 */

test("buildProduction wires cfg.reflectorPort through to RunQaUseCase — a static-gate invalid run reaches reflector.reflect()", async () => {
  let reflectCallCount = 0;
  const cfg = fakeConfig({
    validationStrategies: {
      e2e: { validateAll: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"], infra: false }) },
      code: { validate: async () => ({ ok: true, errors: [], infra: false }) },
    },
    reflectorPort: {
      reflect: async () => { reflectCallCount++; },
    },
  });

  const port = buildProduction(cfg);
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-reflector-smoke",
  });

  assert.equal(outcome.verdict, "invalid");
  assert.equal(reflectCallCount, 1, "cfg.reflectorPort must be wired through to RunQaUseCaseDeps.reflector — a static-gate invalid is gate-true (errorClass E-STATIC is not in the suppressed {E-INFRA, E-FLAKY} set)");
});

test("buildProduction omits reflector entirely when cfg.reflectorPort is absent — no behavior change on a green pass", async () => {
  const port = buildProduction(fakeConfig());

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-reflector-absent-smoke",
  });

  assert.equal(outcome.verdict, "pass");
});

/* root threads cfg.processAudit through to RunQaUseCaseDeps.processAudit — mirrors the reflectorPort
   smoke test immediately above, same black-box style through the public buildProduction() entry
   point. ──────────────────────────────────────────────────────────────────────────────────────────
 */

test("buildProduction wires cfg.processAudit through to RunQaUseCase — a static-gate invalid run reaches processAudit.audit()", async () => {
  let auditCallCount = 0;
  const cfg = fakeConfig({
    validationStrategies: {
      e2e: { validateAll: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"], infra: false }) },
      code: { validate: async () => ({ ok: true, errors: [], infra: false }) },
    },
    processAudit: {
      audit: async () => { auditCallCount++; },
    },
  });

  const port = buildProduction(cfg);
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-process-audit-smoke",
  });

  assert.equal(outcome.verdict, "invalid");
  assert.equal(auditCallCount, 1, "cfg.processAudit must be wired through to RunQaUseCaseDeps.processAudit — a static-gate invalid is gate-true");
});

test("buildProduction omits processAudit entirely when cfg.processAudit is absent — no behavior change on a green pass", async () => {
  const port = buildProduction(fakeConfig());

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-process-audit-absent-smoke",
  });

  assert.equal(outcome.verdict, "pass");
});

/* Root threads cfg.contextMapCapture through to RunQaUseCaseDeps.contextMapCapture — same
   black-box style as reflectorPort/processAudit above. A clean context-mode pass (mode:"context",
   verdict "pass") is the ONLY case that reaches RunQaUseCase's isContextCleanPass capture call. ──
 */

test("buildProduction wires cfg.contextMapCapture through to RunQaUseCase — a clean context-mode pass reaches contextMapCapture.capture()", async () => {
  let captureCallCount = 0;
  const cfg = fakeConfig({
    mode: "context",
    contextMapCapture: {
      capture: async () => { captureCallCount++; },
    },
  });

  const port = buildProduction(cfg);
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "context",
    target: "e2e",
    runId: "composition-root-contextmap-capture-smoke",
  });

  assert.equal(outcome.verdict, "pass");
  assert.equal(captureCallCount, 1, "cfg.contextMapCapture must be wired through to RunQaUseCaseDeps.contextMapCapture — a clean context-mode pass must invoke capture() exactly once");
});

test("buildProduction omits contextMapCapture entirely when cfg.contextMapCapture is absent — no behavior change on a clean context-mode pass", async () => {
  const cfg = fakeConfig({ mode: "context" });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "context",
    target: "e2e",
    runId: "composition-root-contextmap-capture-absent-smoke",
  });

  assert.equal(outcome.verdict, "pass");
});

/* ── buildShadow: always the run engine, shadow-log publication, no side effects ──────────────────── */

test("buildShadow always returns a RunPipelineAdapter", () => {
  const port = buildShadow(fakeConfig());
  assert.ok(port instanceof RunPipelineAdapter);
});

test("buildShadow wires the shadow-log publication path — no PR/Issue collaborator is ever invoked", async () => {
  let prCalled = false;
  let issueCalled = false;
  const cfg = fakeConfig({
    githubPr: {
      openWithAutoMerge: async () => {
        prCalled = true;
        return { url: "https://github.com/org/app/pull/1", number: 1 };
      },
    },
    githubIssue: {
      open: async () => {
        issueCalled = true;
        return { url: "https://github.com/org/app/issues/1", number: 1 };
      },
    },
  });

  const port = buildShadow(cfg);
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-shadow-smoke",
  });

  assert.equal(outcome.verdict, "pass");
  assert.equal(prCalled, false);
  assert.equal(issueCalled, false);
});

test("buildShadow reads a pre-run history snapshot (read-only) — never persists via a durable store", async () => {
  /* A history-write spy plugged in as the historyFilePath-backed collaborator would only be reachable
     if buildShadow used FileRunHistoryAdapter — it must use InMemoryRunHistoryAdapter instead so no
     real file is ever touched. Passing a deliberately-unwritable path proves this: if buildShadow
     wired FileRunHistoryAdapter, the run() would throw on the disallowed write; it must not.
   */
  const cfg = fakeConfig({ historyFilePath: "/nonexistent/dir/that/does/not/exist/history.jsonl" });
  const port = buildShadow(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-shadow-history",
  });

  assert.equal(outcome.verdict, "pass");
});

test("buildProduction selects NullDeployGateAdapter when versionUrl is absent (static/code target)", async () => {
  const cfg = fakeConfig({ versionUrl: undefined });
  const port = buildProduction(cfg);

  /* No versionUrl -> NullDeployGateAdapter (always ok(true)) -> the entry gate never blocks. */
  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-null-gate",
  });

  assert.notEqual(outcome.verdict, "infra-error");
});

test("buildProduction selects the real DeployGatePortAdapter when versionUrl is present", async () => {
  const cfg = fakeConfig({
    versionUrl: "https://dev.example.com/version",
    versionPoll: async () => ({ serving: true }),
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-real-gate",
  });

  assert.equal(outcome.verdict, "pass");
});

/* testIdAttribute must flow from CompositionConfig into the ExecutionPortAdapter's static
   context so PW_TEST_ID_ATTRIBUTE reaches the verdictual Playwright run. NO defaulting logic here —
   undefined flows through; the seed playwright.config.ts already defaults to data-testid.
 */
test("buildProduction threads testIdAttribute into the ExecutionPortAdapter", async () => {
  let capturedTestIdAttribute: string | undefined;
  const cfg = fakeConfig({
    testIdAttribute: "data-cy",
    executionStrategies: {
      e2e: {
        run: async (req) => {
          capturedTestIdAttribute = req.testIdAttribute;
          return { verdict: "pass", cases: [], logs: "" };
        },
      },
      code: { run: async () => ({ verdict: "pass", cases: [], logs: "" }) },
    },
  });
  const port = buildProduction(cfg);

  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-test-id-attribute",
  });

  assert.equal(capturedTestIdAttribute, "data-cy");
});

/* SetupPort (CLAUDE.md run-flow step 3) — genuine-wiring proof: setupCollaborators (OPTIONAL on
   CompositionConfig) must reach the run() call when supplied, and stay a silent no-op when absent
   (every fakeConfig() base case above never supplies it — that already proves the absent-collaborator
   backward-compat path across all the OTHER tests in this file).
 */

test("buildProduction wires setupCollaborators.e2e into the run when target is 'e2e'", async () => {
  let setupCalled = false;
  const cfg = fakeConfig({
    target: "e2e",
    setupCollaborators: {
      e2e: async () => { setupCalled = true; },
      code: async () => { throw new Error("must not be called for target 'e2e'"); },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-setup-e2e",
  });

  assert.equal(setupCalled, true, "the e2e setup collaborator must run before generation when setupCollaborators is wired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction wires setupCollaborators.code into the run when target is 'code'", async () => {
  let setupCalled = false;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    setupCollaborators: {
      e2e: async () => { throw new Error("must not be called for target 'code'"); },
      code: async () => { setupCalled = true; },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-setup-code",
  });

  assert.equal(setupCalled, true, "the code setup collaborator must run before generation when setupCollaborators is wired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction composes specDir as the bare mirrorDir for a code:true app (WorkspacePortAdapter target-awareness)", async () => {
  let capturedSpecDir: string | undefined;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    mirrorDir: "/mirrors/org/code-app",
    checkout: async () => "/mirrors/org/code-app",
    setupCollaborators: {
      e2e: async () => { throw new Error("must not be called for target 'code'"); },
      code: async (specDir) => { capturedSpecDir = specDir; },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-specdir-code",
  });

  assert.equal(capturedSpecDir, "/mirrors/org/code-app", "code target: specDir must be the bare mirrorDir, never mirrorDir/e2e");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction dispatches ValidationPort to the code strategy for a code:true app — a toolchain failure resolves to infra-error, never reaches execute()", async () => {
  let executeCalled = false;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    validationStrategies: {
      e2e: { validateAll: async () => { throw new Error("must not be called for target 'code'"); } },
      code: { validate: async () => ({ ok: false, errors: ["[compile] JAVA_HOME is not set"], infra: true }) },
    },
    executionStrategies: {
      e2e: { run: async () => { throw new Error("must not be called for target 'code'"); } },
      code: { run: async () => { executeCalled = true; return { verdict: "pass", cases: [], logs: "" }; } },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-code-validate-infra",
  });

  assert.equal(outcome.verdict, "infra-error", "a code-target compile-gate toolchain failure must resolve to infra-error, not invalid");
  assert.equal(executeCalled, false, "a validation failure must block BEFORE execution, never call it");
});

/* a code-target review must render the
   "tests" framing (buildReviewerPromptAssembled's own `input.target === "code" ? "tests" : "E2E
   tests"`), not "E2E tests" — closes the ReviewPortAdapter wiring gap (target was never threaded).
 */
test("buildProduction threads cfg.target:'code' onto ReviewInput.target — the code-mode review no longer renders 'E2E tests' framing", async () => {
  let seenTarget: string | undefined;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    needsReview: true,
    reviewRuntime: {
      runtime: { openSession: async () => ({ prompt: async () => ({ output: "{}" }), dispose: async () => {} }) },
      rendering: {
        renderReviewer: (input: { target?: string }) => { seenTarget = input.target; return { text: "", sectionSizes: {} }; },
      },
      verdicts: { parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
    },
  });
  const port = buildProduction(cfg);

  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-review-target-code",
  });

  assert.equal(seenTarget, "code", "ReviewInput.target must be 'code' for a code-target run");
});

/* buildProduction must thread cfg.reviewTimeoutMs into the ReviewPortAdapter it constructs.
   A fake reviewRuntime.runtime.openSession captures the opts it receives so this test observes the
   SAME seam ReviewPortAdapter's own unit test observes, through the real composition wiring.
 */
test("buildProduction threads cfg.reviewTimeoutMs onto ReviewPortAdapter's openSession opts.timeoutMs", async () => {
  let seenTimeoutMs: number | undefined;
  const cfg = fakeConfig({
    needsReview: true,
    reviewTimeoutMs: 360_000,
    reviewRuntime: {
      runtime: {
        openSession: async (_role: string, _cwd: string, opts?: { timeoutMs?: number }) => {
          seenTimeoutMs = opts?.timeoutMs;
          return { prompt: async () => ({ output: "{}" }), dispose: async () => {} };
        },
      },
      rendering: { renderReviewer: () => ({ text: "", sectionSizes: {} }) },
      verdicts: { parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
    },
  });
  const port = buildProduction(cfg);

  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-review-timeout-ms",
  });

  assert.equal(seenTimeoutMs, 360_000, "cfg.reviewTimeoutMs must reach ReviewPortAdapter's openSession opts.timeoutMs — the reviewer needs its OWN budget, not a silently-dropped composition-time value");
});

test("buildProduction with absent cfg.reviewTimeoutMs omits timeoutMs from ReviewPortAdapter's openSession opts (backward compatible)", async () => {
  let sawTimeoutKey = false;
  const cfg = fakeConfig({
    needsReview: true,
    reviewRuntime: {
      runtime: {
        openSession: async (_role: string, _cwd: string, opts?: { timeoutMs?: number }) => {
          sawTimeoutKey = opts !== undefined && "timeoutMs" in opts && opts.timeoutMs !== undefined;
          return { prompt: async () => ({ output: "{}" }), dispose: async () => {} };
        },
      },
      rendering: { renderReviewer: () => ({ text: "", sectionSizes: {} }) },
      verdicts: { parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
    },
  });
  const port = buildProduction(cfg);

  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-review-timeout-ms-absent",
  });

  assert.equal(sawTimeoutKey, false, "absent cfg.reviewTimeoutMs must not fabricate a timeout the composition layer never configured");
});

test("buildProduction surfaces infra-error when a wired setup collaborator throws", async () => {
  const cfg = fakeConfig({
    target: "e2e",
    setupCollaborators: {
      e2e: async () => { throw new Error("npm ci in e2e failed (code 1)"); },
      code: async () => {},
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-setup-throw",
  });

  assert.equal(outcome.verdict, "infra-error", "a setup failure must surface as infra-error, matching src/qa/setup.ts's own contract");
});

test("buildProduction runs without setupCollaborators (absent -> no-op, backward compatible)", async () => {
  const cfg = fakeConfig(); /* fakeConfig()'s base never supplies setupCollaborators */
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-setup-absent",
  });

  assert.equal(outcome.verdict, "pass");
});

test("buildProduction surfaces infra-error when the real deploy gate never serves", async () => {
  const cfg = fakeConfig({
    versionUrl: "https://dev.example.com/version",
    versionPoll: async () => ({ serving: false }),
    /* Bounded low so this test proves the timeout PATH without waiting out a real poll window —
       deployGateTimeoutMs/deployGateIntervalMs are CompositionConfig's own knobs (default 60s/2s in
       production), not hardcoded inside DeployGatePortAdapter.
     */
    deployGateTimeoutMs: 20,
    deployGateIntervalMs: 5,
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-gate-timeout",
  });

  assert.equal(outcome.verdict, "infra-error");
});

/* composition-root MUST pass needsReview:false into GenerationPortAdapter's static ctx REGARDLESS
   of cfg.needsReview — RunQaUseCase's ReviewPort is the single reviewer; GenerateTestsUseCase's
   internal degraded reviewer must never fire on the orchestrated path. The prior judge round found
   this wiring correct but UNTESTED (a one-line revert to `needsReview: cfg.needsReview` would have
   passed the whole gate). This test is the executable proof: a recording generationUseCase fake
   observes the actual input the adapter builds from its ctx.
 */
test("wireAdapters hardcodes needsReview:false into the generation ctx even when cfg.needsReview is true (single-reviewer architecture)", async () => {
  const seenNeedsReview: boolean[] = [];
  const cfg = fakeConfig({
    needsReview: true, /* the RunQaConfig knob — must NOT leak into the generation ctx */
    generationUseCase: {
      generate: async (input: { needsReview?: boolean }) => {
        seenNeedsReview.push(input.needsReview === true);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  });
  const port = buildShadow(cfg);
  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-single-reviewer",
  });

  assert.ok(seenNeedsReview.length > 0, "the generation use-case must have been invoked");
  assert.ok(
    seenNeedsReview.every((v) => v === false),
    "GenerationPortAdapter's ctx must carry needsReview:false on every generate() call — the internal degraded reviewer must never fire on the orchestrated path",
  );
});

/* wiring proof. groundingCollaborators/reviewDomGroundingCollaborators (OPTIONAL on
   CompositionConfig) must reach the run() call when supplied, and stay a silent no-op (isCode OR
   absent collaborators) otherwise — every fakeConfig() base case above never supplies them, which
   already proves the absent-collaborator backward-compat path across the OTHER tests in this file.
 */

test("buildProduction wires groundingCollaborators.buildContextPack into the run when target is 'e2e' — contextPack reaches OpencodeRunInput", async () => {
  let buildCalled = false;
  const seenContextPacks: Array<string | undefined> = [];
  const cfg = fakeConfig({
    target: "e2e",
    isCode: false,
    baseUrl: "https://dev.example.com",
    groundingCollaborators: {
      buildContextPack: async () => {
        buildCalled = true;
        return { text: "## Context Pack\n\nwired", blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
      },
    },
    generationUseCase: {
      generate: async (input) => {
        seenContextPacks.push(input.contextPack);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-grounding-contextpack",
  });

  assert.equal(buildCalled, true, "the injected buildContextPack collaborator must have run before the initial generate() call");
  assert.ok(seenContextPacks.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenContextPacks[0], "## Context Pack\n\nwired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction does NOT wire grounding on the code target, even when groundingCollaborators is supplied (isCode has no DOM/routes to ground)", async () => {
  let buildCalled = false;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    groundingCollaborators: {
      buildContextPack: async () => { buildCalled = true; return { text: "should never run", blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }; },
    },
    setupCollaborators: { e2e: async () => {}, code: async () => {} },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-grounding-code-skip",
  });

  assert.equal(buildCalled, false, "groundingCollaborators must never be invoked on the code target");
  assert.equal(outcome.verdict, "pass");
});

/* Present -> wireAdapters constructs a StructuralSignalPortAdapter over the supplied code graph and co-change history.
   Absent -> the use-case's own structuralSignal dep stays undefined — NEVER a stub ok([])-shaped fake.
 */

test("buildProduction wires structuralSignal when the code graph and the co-change history are supplied — the rendered advisory block reaches OpencodeRunInput.staticSignal", async () => {
  const seenStaticSignals: Array<string | undefined> = [];
  const seenSymbolFlags: Array<boolean | undefined> = [];
  const cfg = fakeConfig({
    mode: "diff",
    codeGraph: recordingCodeGraph().codeGraph,
    coChange: quietCoChange,
    vcs: {
      blastRadius: async (sha) => BlastRadius.of(sha, ["src/x.ts"]),
      message: async () => "feat: add x",
      diff: async () => "diff --git a/src/x.ts b/src/x.ts\n+ handleX();",
    },
    generationUseCase: {
      generate: async (input) => {
        seenStaticSignals.push(input.staticSignal);
        seenSymbolFlags.push(input.staticSignalHasSymbols);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-structural-signal-present",
  });

  assert.ok(seenStaticSignals.length > 0, "generationUseCase.generate must have been invoked");
  assert.match(seenStaticSignals[0] ?? "", /Structural blast radius/, "the composed advisory block must reach OpencodeRunInput.staticSignal when the collaborator is wired and the repo resolves to an indexed project");
  assert.equal(seenSymbolFlags[0], true, "the graph returned an impacted symbol, so the prompt is told the signal names symbols");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction: a graph that knows only co-change files for the diff gives a signal with no symbol flag on OpencodeRunInput", async () => {
  const seen: Array<{ signal: string | undefined; flag: boolean | undefined; hasFlagKey: boolean }> = [];
  const cfg = fakeConfig({
    mode: "diff",
    codeGraph: { ...recordingCodeGraph().codeGraph, impactedSymbols: async () => ok({ indexedSha: "abc1234", symbols: [], truncated: false }) },
    coChange: { coChangeCoupling: async () => ok([{ file: "src/y.ts", couplingScore: 0.8, coChanges: 5 }]) },
    vcs: {
      blastRadius: async (sha) => BlastRadius.of(sha, ["src/x.ts"]),
      message: async () => "feat: add x",
      diff: async () => "diff --git a/src/x.ts b/src/x.ts\n+ handleX();",
    },
    generationUseCase: {
      generate: async (input) => {
        seen.push({ signal: input.staticSignal, flag: input.staticSignalHasSymbols, hasFlagKey: "staticSignalHasSymbols" in input });
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  });
  const port = buildProduction(cfg);

  await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-structural-signal-co-change-only",
  });

  assert.ok(seen.length > 0, "generationUseCase.generate must have been invoked");
  assert.ok((seen[0]?.signal ?? "").includes("src/y.ts"), "the co-change file is in the signal: the block is not dropped");
  assert.equal(seen[0]?.hasFlagKey, false, "and it names no symbol, so the flag is absent");
  assert.doesNotMatch(seen[0]?.signal ?? "", /blast radius|call graph/i, "and the block does not present itself as an exploration of what the change reaches");
});

test("buildProduction leaves structuralSignal undefined when the code graph is absent (no section)", async () => {
  const seenStaticSignals: Array<string | undefined> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenStaticSignals.push(input.staticSignal);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  }); /* fakeConfig()'s base never supplies a code graph */
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-structural-signal-absent",
  });

  assert.ok(seenStaticSignals.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenStaticSignals[0], undefined, "staticSignal must stay entirely absent when no code graph is wired");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction degrades structuralSignal to no section when the repo is not indexed (unindexed-repo degrade)", async () => {
  const seenStaticSignals: Array<string | undefined> = [];
  const cfg = fakeConfig({
    mode: "diff",
    /* The index of this repo failed: every query answers unavailable, as the real adapter does for a repo the run did not index. */
    codeGraph: {
      ...recordingCodeGraph().codeGraph,
      syncTo: async (repo, sha) => ({ repo, engine: "fake", engineVersion: null, sha, outcome: "failed", durationMs: 0, nodeCount: null, edgeCount: null, reason: "x" }),
      impactedSymbols: async () => err({ reason: "the repo is not indexed in this run" }),
    },
    coChange: quietCoChange,
    generationUseCase: {
      generate: async (input) => {
        seenStaticSignals.push(input.staticSignal);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-structural-signal-unindexed",
  });

  assert.ok(seenStaticSignals.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenStaticSignals[0], undefined, "an unindexed repo must degrade to no staticSignal, never a fabricated or empty-but-present section");
  assert.equal(outcome.verdict, "pass");
});

/* The OPTIONAL serviceTopology collaborator: present -> wireAdapters constructs a
   ServiceLinksPortAdapter over a REAL MirrorRegistryAdapter (DI, not a static call) and a real
   BoundaryProfileProviderPort. Absent -> serviceLinks stays undefined, NEVER a stub.
 */

test("buildProduction wires serviceLinks when a serviceTopology collaborator is supplied — the REAL MirrorRegistryAdapter(mirrorRoot) encoding is exercised end-to-end (existsSync sees the SAME '__'-joined dir wireAdapters constructs)", async () => {
  const root = mkdtempSync(join(tmpdir(), "composition-service-links-"));
  try {
    /* MirrorRegistryAdapter's own formula: join(mirrorRoot, repo.replaceAll("/", "__")) — creating
       dirs under exactly that encoding proves wireAdapters constructed a REAL MirrorRegistryAdapter
       (not a stub/bypass): if it were a static/wrong formula, the adapter's existsSync checks below
       would find nothing and short-circuit to {links:[],drift:[]} BEFORE ever calling forApp().
     */
    mkdirSync(join(root, "org__front"), { recursive: true });
    mkdirSync(join(root, "org__ms-orders"), { recursive: true });

    const httpProfile: BoundaryProfile = {
      transport: "http",
      frontFiles: "*.api.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
      servicePrefixTemplate: "name-{service}-api",
      serviceRepoTemplate: "ms-name-{service}",
      openApiPath: "openapi.yaml",
    };
    let forAppCallCount = 0;
    let forAppCalledWith: string | undefined;
    const seenServiceLinks: Array<unknown[] | undefined> = [];
    const cfg = fakeConfig({
      mode: "diff",
      repo: "org/front",
      serviceTopology: {
        appName: "app",
        primaryRepo: "org/front",
        mirrorRoot: root,
        services: [{ repo: "org/ms-orders" }],
        boundaryProfiles: {
          forApp: async (appName: string) => { forAppCallCount++; forAppCalledWith = appName; return [httpProfile]; },
        },
      },
      generationUseCase: {
        generate: async (input) => {
          seenServiceLinks.push(input.serviceLinks);
          return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
        },
      },
    });
    const port = buildProduction(cfg);

    const outcome = await port.run({
      app: "app",
      sha: Sha.of("abc1234"),
      source: "manual",
      mode: "diff",
      target: "e2e",
      runId: "composition-root-service-links-present",
    });

    assert.ok(seenServiceLinks.length > 0, "generationUseCase.generate must have been invoked");
    assert.equal(forAppCallCount, 1, "boundaryProfiles.forApp() must have been called exactly once — this only happens PAST the existsSync gate, proving the REAL MirrorRegistryAdapter('__'-join) resolved to the SAME dirs this test created on disk");
    assert.equal(forAppCalledWith, "app", "forApp must be called with the serviceTopology.appName supplied via CompositionConfig");
    assert.equal(outcome.verdict, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildProduction leaves serviceLinks undefined when serviceTopology is absent (no key, backward compatible)", async () => {
  const seenEnrichments: Array<Record<string, unknown>> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenEnrichments.push(input as unknown as Record<string, unknown>);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  }); /* fakeConfig()'s base never supplies serviceTopology */
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-service-links-absent",
  });

  assert.ok(seenEnrichments.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal(seenEnrichments[0]?.serviceLinks, undefined, "serviceLinks must stay entirely absent when no serviceTopology collaborator is wired");
  assert.equal(outcome.verdict, "pass");
});

/* CompositionConfig.triggerService is advisory, prompt-context only (reaches
   GenerationPortAdapter's ctx.service -> OpencodeRunInput.service and NOTHING else: no
   verdict/gate/coverage/publish path reads it). Present -> the generation input carries
   {repo, mirrorDir(, openapi)} for the TRIGGERING service. Absent (the common same-repo case) ->
   the key is omitted entirely.
 */

test("buildProduction threads cfg.triggerService into OpencodeRunInput.service when the run is cross-repo", async () => {
  const seenServices: Array<unknown> = [];
  const cfg = fakeConfig({
    mode: "diff",
    repo: "org/front",
    triggerService: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi.yaml" },
    generationUseCase: {
      generate: async (input) => {
        seenServices.push(input.service);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-trigger-service-present",
  });

  assert.ok(seenServices.length > 0, "generationUseCase.generate must have been invoked");
  assert.deepEqual(seenServices[0], { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi.yaml" });
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction leaves OpencodeRunInput.service entirely absent when cfg.triggerService is not supplied (same-repo run)", async () => {
  const seenInputs: Array<Record<string, unknown>> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenInputs.push(input as unknown as Record<string, unknown>);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  }); /* fakeConfig()'s base never supplies triggerService */
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-trigger-service-absent",
  });

  assert.ok(seenInputs.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal("service" in (seenInputs[0] ?? {}), false, "no cfg.triggerService (the common same-repo case) must OMIT the key, not set it to undefined");
  assert.equal(outcome.verdict, "pass");
});

/* The context pack ranks the map's routes by the run's changed files. On a cross-repo run those are the triggering service's files, so a declared path counts only where that service's snapshot was staged: inside the working copy, under the e2e dir. A map may name that root from the working copy or from the e2e dir, so the composition derives both from the directories it already holds. A same-repo run has no such root. */

/** The staged roots the pack received on a run of `overrides`, or "absent" when the pack's input carried no such key. */
async function stagedRootsSeenByThePack(overrides: Partial<CompositionConfig>): Promise<unknown> {
  const seen: Array<Record<string, unknown>> = [];
  const cfg = fakeConfig({
    mode: "diff",
    groundingCollaborators: {
      buildContextPack: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return { text: undefined, domBytes: 0, contractBytes: 0 };
      },
    },
    ...overrides,
  });
  const port = buildProduction(cfg);
  await port.run({ app: "app", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "composition-root-staged-roots" });
  assert.ok(seen.length > 0, "the pre-generation grounding must have built a context pack");
  return "stagedRoots" in seen[0]! ? seen[0]!.stagedRoots : "absent";
}

test("buildProduction gives the context pack the staged roots of the triggering service, as the working copy and as the e2e dir name them", async () => {
  const roots = await stagedRootsSeenByThePack({
    mirrorDir: "/mirrors/org__front",
    e2eRelDir: "e2e",
    triggerService: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__front/e2e/.qa/service-context/org__orders-svc" },
  });
  assert.deepEqual(roots, ["e2e/.qa/service-context/org__orders-svc", ".qa/service-context/org__orders-svc"]);
});

test("buildProduction names the e2e dir's own root from where the e2e dir really is, not from a fixed name", async () => {
  const roots = await stagedRootsSeenByThePack({
    mirrorDir: "/mirrors/org__front",
    e2eRelDir: "tests/e2e",
    triggerService: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__front/tests/e2e/.qa/service-context/org__orders-svc" },
  });
  assert.deepEqual(roots, ["tests/e2e/.qa/service-context/org__orders-svc", ".qa/service-context/org__orders-svc"]);
});

test("buildProduction names no root a staged snapshot does not lie inside, and the run stays a cross-repo run", async () => {
  const insideTheCopyOnly = await stagedRootsSeenByThePack({
    mirrorDir: "/mirrors/org__front",
    e2eRelDir: "e2e",
    triggerService: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__front/other/service-context/org__orders-svc" },
  });
  const outsideTheCopy = await stagedRootsSeenByThePack({
    mirrorDir: "/mirrors/org__front",
    e2eRelDir: "e2e",
    triggerService: { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc" },
  });
  assert.deepEqual(insideTheCopyOnly, ["other/service-context/org__orders-svc"], "only the working copy holds it");
  assert.deepEqual(outsideTheCopy, [], "no directory holds it: nothing to name, but the key is still there");
});

test("buildProduction gives the context pack no staged roots on a same-repo run", async () => {
  assert.equal(await stagedRootsSeenByThePack({}), "absent");
});

/* CompositionConfig.services is advisory, prompt-context ONLY (reaches GenerationPortAdapter's
   ctx.services -> OpencodeRunInput.services and NOTHING else: no verdict/gate/coverage/publish path
   reads it). Present -> every declared service ref reaches the generation input. Absent/empty ->
   the key is omitted entirely.
 */

test("buildProduction threads cfg.services into OpencodeRunInput.services for a context-mode run", async () => {
  const seenServicesList: Array<unknown> = [];
  const cfg = fakeConfig({
    mode: "context",
    repo: "org/front",
    services: [
      { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi/orders.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/mirrors/org__payments-svc" },
    ],
    generationUseCase: {
      generate: async (input) => {
        seenServicesList.push(input.services);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "context",
    target: "e2e",
    runId: "composition-root-services-present",
  });

  assert.ok(seenServicesList.length > 0, "generationUseCase.generate must have been invoked");
  assert.deepEqual(seenServicesList[0], [
    { repo: "org/orders-svc", mirrorDir: "/mirrors/org__orders-svc", openapi: "openapi/orders.yaml" },
    { repo: "org/payments-svc", mirrorDir: "/mirrors/org__payments-svc" },
  ]);
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction leaves OpencodeRunInput.services entirely absent when cfg.services is not supplied", async () => {
  const seenInputs: Array<Record<string, unknown>> = [];
  const cfg = fakeConfig({
    mode: "diff",
    generationUseCase: {
      generate: async (input) => {
        seenInputs.push(input as unknown as Record<string, unknown>);
        return { specs: ["a.spec.ts"], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
      },
    },
  }); /* fakeConfig()'s base never supplies services */
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-services-absent",
  });

  assert.ok(seenInputs.length > 0, "generationUseCase.generate must have been invoked");
  assert.equal("services" in (seenInputs[0] ?? {}), false, "no cfg.services (the common case) must OMIT the key, not set it to undefined or an empty array");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction runs without groundingCollaborators/reviewDomGroundingCollaborators (absent -> no-op, backward compatible)", async () => {
  const cfg = fakeConfig({ target: "e2e", isCode: false }); /* fakeConfig()'s base never supplies either */
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-grounding-absent",
  });

  assert.equal(outcome.verdict, "pass", "the run must complete normally with no grounding collaborators wired");
});

/* OPTIONAL on CompositionConfig, absent -> the use-case's pre-exec grounding phase stays a no-op
   (preExecAmbiguityCatches stays 0), and gated `!cfg.isCode` (isCode has no DOM/routes to ground).
 */

test("buildProduction wires preExecGrounding into the run when target is 'e2e' and a captureRouteTrees-shaped collaborator is supplied", async () => {
  /* A REAL specDir with at least one on-disk *.spec.ts — the adapter enumerates + reads specs off
     disk itself (the "adapter resolves its own paths" precedent), so an unpopulated fakeConfig()
     mirrorDir (never a real directory) would short-circuit BEFORE ever calling captureRouteTrees.
   */
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-preexec-wired-"));
  try {
    mkdirSync(join(mirrorDir, "e2e"), { recursive: true });
    writeFileSync(join(mirrorDir, "e2e", "home.spec.ts"), "test('home', async ({ page }) => { await page.goto('/home'); });");

    let captureCalled = false;
    /* The static mirrorDir is the directory checkout() returns, as in production: the adapter's confined reads are anchored on it. */
    const cfg = fakeConfig({
      target: "e2e",
      isCode: false,
      baseUrl: "https://dev.example.com",
      mirrorDir,
      checkout: async () => mirrorDir,
      preExecGroundingCollaborators: {
        captureRouteTrees: async () => {
          captureCalled = true;
          return [{ route: "/home", nodes: ["heading: Home"] }];
        },
      },
    });
    const port = buildProduction(cfg);

    const outcome = await port.run({
      app: "app",
      sha: Sha.of("abc1234"),
      source: "manual",
      mode: "diff",
      target: "e2e",
      runId: "composition-root-preexec-grounding-wired",
    });

    assert.equal(captureCalled, true, "the injected captureRouteTrees collaborator must have run (the pre-exec grounding check)");
    assert.equal(outcome.verdict, "pass");
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true });
  }
});

test("buildProduction does NOT wire preExecGrounding on the code target, even when preExecGroundingCollaborators is supplied (isCode has no DOM/routes to ground)", async () => {
  let captureCalled = false;
  const cfg = fakeConfig({
    target: "code",
    isCode: true,
    preExecGroundingCollaborators: {
      captureRouteTrees: async () => { captureCalled = true; return []; },
    },
    setupCollaborators: { e2e: async () => {}, code: async () => {} },
  });
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "code",
    runId: "composition-root-preexec-grounding-code-skip",
  });

  assert.equal(captureCalled, false, "preExecGroundingCollaborators must never be invoked on the code target");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction runs without preExecGroundingCollaborators (absent -> no-op, backward compatible)", async () => {
  const cfg = fakeConfig({ target: "e2e", isCode: false }); /* fakeConfig()'s base never supplies it */
  const port = buildProduction(cfg);

  const outcome = await port.run({
    app: "app",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "composition-root-preexec-grounding-absent",
  });

  assert.equal(outcome.verdict, "pass", "the run must complete normally with no preExecGrounding collaborators wired");
});

/* The gate must actually fire through composition, not just receive a call: a duplicate
   page-rooted selector must produce preExecAmbiguityCatches > 0. */
test("buildProduction end-to-end: a duplicate page-rooted selector in the captured route trips the pre-exec ambiguity gate (preExecAmbiguityCatches > 0)", async () => {
  /* A REAL specDir (mirrorDir/e2eRelDir) — the adapter under test resolves its own paths off disk
     (the "adapter resolves its own paths" precedent SetupPort/ExecutionPort/ReviewDomGroundingPort
     already use), so this is exercised against real fs, not a readSpecSource passthrough.
   */
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-preexec-e2e-"));
  try {
    mkdirSync(join(mirrorDir, "e2e"), { recursive: true });
    /* Page-rooted, undisambiguated getByRole — the ONE shape unscopedMultipleContradictions keeps
       (selector-check.ts): rooted directly on `page`, no trailing .first()/.nth()/.filter().
     */
    writeFileSync(
      join(mirrorDir, "e2e", "ambiguous.spec.ts"),
      "test('checkout', async ({ page }) => { await page.goto('/checkout'); await page.getByRole('button', { name: 'Submit' }).click(); });",
    );

    const cfg = fakeConfig({
      target: "e2e",
      isCode: false,
      baseUrl: "https://dev.example.com",
      mirrorDir,
      checkout: async () => mirrorDir,
      generationUseCase: {
        generate: async () => ({
          specs: ["ambiguous.spec.ts"],
          approved: true,
          reviewed: false,
          end: GENERATION_END.DELIVERED,
        }),
      },
      preExecGroundingCollaborators: {
        /* Stubs the render seam only — captureRouteTrees' own route-extraction/filtering logic still
           runs for real; this collaborator plays the role of CaptureDomDeps.render, returning a
           route with a DUPLICATE page-rooted node ("button: Submit" twice) so selectorUnique's
           count > 1 fires a MULTIPLE contradiction for the spec's page.getByRole('button', {name:
           'Submit'}) call.
         */
        captureRouteTrees: async () => [
          { route: "/checkout", nodes: ["button: Submit", "button: Submit"] },
        ],
      },
    });
    const port = buildProduction(cfg);

    const outcome = await port.run({
      app: "app",
      sha: Sha.of("abc1234"),
      source: "manual",
      mode: "diff",
      target: "e2e",
      runId: "composition-root-preexec-grounding-fires",
    });

    const preExecAmbiguityCatches = outcome.gateSignals.preExecAmbiguityCatches ?? 0;
    assert.ok(
      preExecAmbiguityCatches > 0,
      `expected the pre-exec ambiguity gate to fire (preExecAmbiguityCatches > 0), got ${preExecAmbiguityCatches}`,
    );
  } finally {
    rmSync(mirrorDir, { recursive: true, force: true });
  }
});

/* ── one code graph per run: the index phase builds it, the structural signal reads the same instance ──────────── */

function recordingCodeGraph() {
  const calls: string[] = [];
  const codeGraph: CodeGraphPort = {
    syncTo: async (repo, sha) => { calls.push(`syncTo ${repo} ${sha}`); return { repo, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 }; },
    impactedSymbols: async (repo) => { calls.push(`impactedSymbols ${repo}`); return ok({ indexedSha: "abc1234", symbols: [{ file: "src/x.ts", symbol: "handleX", kind: "function", depth: 0 }], truncated: false }); },
    callersOf: async () => ok({ indexedSha: "abc1234", symbols: [], truncated: false }),
    routes: async () => ok([]),
  };
  return { calls, codeGraph };
}

const quietCoChange: CoChangePort = { coChangeCoupling: async () => ok([]) };

const diffRun = {
  app: "app",
  sha: Sha.of("abc1234"),
  source: "manual",
  mode: "diff",
  target: "e2e",
} as const;

const diffVcs = {
  blastRadius: async (sha: Sha) => BlastRadius.of(sha, ["src/x.ts"]),
  message: async () => "feat: add x",
  diff: async () => "diff --git a/src/x.ts b/src/x.ts\n+ handleX();",
};

test("buildProduction indexes the repo through cfg.codeGraph and the structural signal reads that same instance", async () => {
  const { calls, codeGraph } = recordingCodeGraph();
  const cfg = fakeConfig({ mode: "diff", codeGraph, coChange: quietCoChange, vcs: diffVcs });
  const port = buildProduction(cfg);

  const outcome = await port.run({ ...diffRun, runId: "composition-root-graph-shared" });

  assert.deepEqual(calls.slice(0, 2), [`syncTo ${MIRROR} abc1234`, `impactedSymbols ${MIRROR}`], "the run indexes first, then the signal asks the index it built");
  assert.equal(outcome.verdict, "pass");
});

test("buildProduction still indexes without the co-change history, but builds no structural signal", async () => {
  const { calls, codeGraph } = recordingCodeGraph();
  const cfg = fakeConfig({ mode: "diff", codeGraph, vcs: diffVcs });
  const port = buildProduction(cfg);

  await port.run({ ...diffRun, runId: "composition-root-graph-no-cochange" });

  assert.deepEqual(calls, [`syncTo ${MIRROR} abc1234`]);
});

/* The run_spec loop is wired only when the shell hands the root its registry; the adapter it builds executes through the run's own execution and cleanup ports. */
test("wireAdapters builds the run_spec loop port from cfg.closedLoop and omits it when the config has none", async () => {
  const { ClosedLoopRegistry } = await import("@contexts/qa-run-orchestration/infrastructure/closed-loop-registry.ts");
  const { AccountLock } = await import("@contexts/test-execution/domain/account-lock.ts");
  const without = wireAdapters(fakeConfig());
  assert.equal("closedLoop" in without, false);

  const registry = new ClosedLoopRegistry();
  const wired = wireAdapters(fakeConfig({
    closedLoop: {
      registry,
      setting: { enabled: true, limits: { maxCalls: 3, perCallMs: 30_000, maxDevWrites: 5 } },
      generatorRuntimeCanCall: () => true,
      account: "app/user",
      lock: new AccountLock(),
      redact: (text) => text,
    },
  }));
  const handle = await wired.closedLoop!.open({ runId: "r1", app: "app", mode: "diff", mirrorDir: "/mirrors/org/app", specDir: "/mirrors/org/app/e2e" });
  assert.deepEqual(handle?.limits, { maxCalls: 3, perCallMs: 30_000, maxDevWrites: 5 });
  assert.equal(registry.size, 1);
  await handle?.close();
});

test("a code-target composition never gets the run_spec loop, whatever the config says", async () => {
  const { ClosedLoopRegistry } = await import("@contexts/qa-run-orchestration/infrastructure/closed-loop-registry.ts");
  const { AccountLock } = await import("@contexts/test-execution/domain/account-lock.ts");
  const wired = wireAdapters(fakeConfig({
    isCode: true,
    target: "code",
    closedLoop: { registry: new ClosedLoopRegistry(), setting: { enabled: true, limits: { maxCalls: 3, perCallMs: 30_000, maxDevWrites: 5 } }, generatorRuntimeCanCall: () => true, account: "a", lock: new AccountLock(), redact: (t) => t },
  }));
  assert.equal("closedLoop" in wired, false);
});

/* The authenticated agent browser is wired only when the shell hands the root its registry, and only for an e2e app with a DEV url. */
test("wireAdapters builds the agent browser port from cfg.agentBrowser and omits it when the config has none", async () => {
  const { AgentBrowserRegistry } = await import("@contexts/qa-run-orchestration/infrastructure/agent-browser-registry.ts");
  const { AccountLock } = await import("@contexts/test-execution/domain/account-lock.ts");
  const without = wireAdapters(fakeConfig({ baseUrl: "https://dev.example.com" }));
  assert.equal("agentBrowser" in without, false);

  const wiring = {
    registry: new AgentBrowserRegistry(),
    setting: { enabled: true, denyRoutes: [], allowMutating: [] },
    generatorRuntimeCanCall: () => false,
    launcher: { launch: async () => { throw new Error("unused"); } },
    account: "app/user",
    lock: new AccountLock(),
    redact: (text: string) => text,
  };
  const wired = wireAdapters(fakeConfig({ baseUrl: "https://dev.example.com", agentBrowser: wiring }));
  assert.equal(await wired.agentBrowser!.open({ runId: "r1", app: "app", mode: "diff", specDir: "/m/e2e" }), undefined, "the port is there and applies its own conditions");

  assert.equal("agentBrowser" in wireAdapters(fakeConfig({ agentBrowser: wiring })), false, "an app with no DEV url has nothing to browse");
  assert.equal("agentBrowser" in wireAdapters(fakeConfig({ isCode: true, target: "code", baseUrl: "https://dev.example.com", agentBrowser: wiring })), false, "a code target never gets it");
});

/* The lead's code-graph tool is wired from the run's explore port and the shell's registry, for an e2e app only. */
test("wireAdapters builds the lead's code-graph tool over cfg.codeExplore and omits it without the explore, the wiring or for a code target", async () => {
  const { CodeGraphToolRegistry } = await import("@contexts/qa-run-orchestration/infrastructure/code-graph-tool-registry.ts");
  const explore = { explore: async () => ok({ text: "**Exploration: x**", indexedSha: "abc1234" }) };
  const wiring = { registry: new CodeGraphToolRegistry(), generatorRuntimeCanCall: () => true, redact: (text: string) => text };
  assert.equal("codeGraphTools" in wireAdapters(fakeConfig({ codeGraphTools: wiring })), false, "no explore, no tool");
  assert.equal("codeGraphTools" in wireAdapters(fakeConfig({ codeExplore: explore })), false, "no wiring, no tool");
  assert.equal("codeGraphTools" in wireAdapters(fakeConfig({ isCode: true, target: "code", codeExplore: explore, codeGraphTools: wiring })), false, "a code target never gets it");

  const wired = wireAdapters(fakeConfig({ codeExplore: explore, codeGraphTools: wiring }));
  const handle = await wired.codeGraphTools!.open({ runId: "r1" });
  assert.ok(handle, "the port is there and, with a lead that can call a custom tool, grants the right");
  wiring.registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-generator" });
  const answer = await wiring.registry.find("lead")!.call({ sessionId: "lead", agent: "qa-generator", query: { action: "explore", terms: ["x"] } });
  assert.deepEqual(answer.ok && answer.indexedSha, "abc1234", "the call is answered by the run's explore");
  handle.close();
});

test("wireAdapters hands the use case the app's coordination settings, and omits them when the config has none", () => {
  const without = wireAdapters(fakeConfig());
  assert.equal("coordinationSettings" in without, false);
  const settings = resolveCoordinationSettings({ maxFlows: 3 });
  const wired = wireAdapters(fakeConfig({ coordinationSettings: settings }));
  assert.deepEqual(wired.coordinationSettings, settings);
});

test("wireAdapters wires the lead/sidekick mode only for an e2e run whose shell named a place for the workspaces, and never the file-count proposer", () => {
  const delegation = { workspaceRoot: "/mirrors/.qa-delegations", sidekickProvider: () => "opencode" as const, plannerProvider: () => "opencode" as const };
  const none = wireAdapters(fakeConfig());
  assert.equal("leadSidekicks" in none, false);
  assert.equal("sidekickProvider" in none, false);

  const wired = wireAdapters(fakeConfig({ delegation }));
  assert.equal(typeof wired.leadSidekicks?.coordinate, "function");
  assert.equal(wired.sidekickProvider?.(), "opencode");
  assert.equal(wired.plannerProvider?.(), "opencode");

  const code = wireAdapters(fakeConfig({ delegation, isCode: true }));
  assert.equal("leadSidekicks" in code, false);

  for (const deps of [none, wired, code]) {
    assert.equal("coordination" in deps, false, "no proposer decides who authors a change");
    assert.equal("coordinationEnabledPoints" in deps, false);
    assert.equal("sidekick" in deps, false);
  }
});



/* ── Observability: the sources, the suite store and the validation are traced only when the shell supplied a telemetry port. ── */

test("with a telemetry port the learning, curriculum and suite store ports are traced, and without one they are the plain adapters", () => {
  const curriculumPort = { select: async () => [], fold: async () => {} };
  const suiteStore = { restore: async () => ({ restored: 0, trackedWins: 0, overlaid: 0, authRestored: false }), fingerprint: async () => new Map(), capture: async () => ({ entries: 0, admitted: 0, dropped: 0, skipped: [] }), demoteAuth: async () => {} };
  const traced = wireAdapters(fakeConfig({ telemetry: new NoopTelemetry(), curriculumPort, suiteStore }));
  assert.ok(traced.learning instanceof TracedLearningPort);
  assert.ok(traced.curriculum instanceof TracedCurriculumPort);
  assert.ok(traced.suiteStore instanceof TracedSuiteStore);
  const plain = wireAdapters(fakeConfig({ curriculumPort, suiteStore }));
  assert.equal(plain.learning instanceof TracedLearningPort, false);
  assert.equal(plain.curriculum, curriculumPort);
  assert.equal(plain.suiteStore, suiteStore);
});

test("spec snapshots wrap the validation of an e2e run only, and only when a snapshot port is supplied", () => {
  assert.ok(wireAdapters(fakeConfig({ specSnapshots: NO_SPEC_SNAPSHOTS })).validation instanceof SpecSnapshotValidationPort);
  assert.equal(wireAdapters(fakeConfig()).validation instanceof SpecSnapshotValidationPort, false);
  assert.equal(wireAdapters(fakeConfig({ specSnapshots: NO_SPEC_SNAPSHOTS, isCode: true, target: "code" })).validation instanceof SpecSnapshotValidationPort, false);
});
