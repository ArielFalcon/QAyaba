/* Permanent seam: the engine's RunOutcome reaching the history store, and AppConfig ↔ EngineRootDeps.
   qa-engine cannot import src/, so this shell test is the drift gate. The stored outcome is derived from the
   engine's type, so only the forwarding is pinned here. */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome";
import { GENERATION_END } from "@kernel/generation-end";
import { wireEngine, type EngineRootDeps } from "./engine-root";
import { ConfinedPathError } from "../../qa-engine/src/shared-infrastructure/spec-path-confinement";

import { type RunHistorySqliteAdapterDeps, SqliteRunHistoryAdapter } from "../persistence/run-history-sqlite-adapter";
import { buildEngineRootDeps, type RunEngineFactoryDeps } from "./run-engine-factory";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../agent-runtime/opencode-client";
import { AgentRuntimeFacade } from "../agent-runtime/facades";
import type { AgentFacade, AgentProvider, AgentRuntimeStrategy, StepLimits } from "../agent-runtime/types";
import type { OpencodeRunInput, ReviewInput } from "@contexts/generation/application/index";

/* ── shared sentinel helpers ─────────────────────────────────────────────────────────────────────
   A sentinel is a value that is IMPOSSIBLE to produce by accident (unlike "", 0, false, or []),
   so `assert.equal(captured.field, SENTINEL)` fails loudly if the adapter silently substitutes a
   default, drops the field, or forwards the wrong one.
 */
const S = (field: string): string => `__SENTINEL__${field}__`;

/* ════════════════════════════════════════════════════════════════════════════════════════════════
   (d) PERSISTENCE surface — the engine outcome reaching SqliteRunHistoryAdapter's saveOutcome
   ════════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("seam-parity: PERSISTENCE (SqliteRunHistoryAdapter.save forwards the engine outcome)", () => {
  test("SqliteRunHistoryAdapter.save() forwards the engine outcome to the injected saveOutcome (the seam a real caller uses)", async () => {
    let captured: unknown;
    const deps: RunHistorySqliteAdapterDeps = { saveOutcome: (o) => { captured = o; } };
    const adapter = new SqliteRunHistoryAdapter(deps);
    await adapter.save({
      runId: S("runId"), app: S("app"), sha: S("sha"), mode: "diff", target: "e2e", verdict: "pass",
      errorClass: null,
      gateSignals: { static: true, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0 },
      at: "2026-07-02T00:00:00.000Z",
    });
    assert.equal((captured as { runId: string }).runId, S("runId"), "SqliteRunHistoryAdapter.save() dropped runId before it reached saveOutcome");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════════
   (e) COMPOSITION surface — EngineRootDeps vs buildEngineRootDeps
   ════════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("seam-parity: COMPOSITION (EngineRootDeps vs buildEngineRootDeps)", () => {
  /* Fields buildEngineRootDeps deliberately does NOT populate, each with a reason.
     This is the SAME class of audit that caught the original 5 gaps (baseUrl/branch/mode/guidance/
     testIdAttribute), mechanized: every optional EngineRootDeps field must appear here OR be
     asserted present by buildEngineRootDepsTest below.
   */
  const OPTIONAL_ALLOWLIST: Record<string, string> = {
    guidance: "supplied by buildEngineRootDeps ONLY when run.guidance is present (asserted below as a present-when-given case) — legitimately absent for diff-mode runs with no manual guidance.",
    diff: "DELIBERATELY static '' — see this fn's own header 'difference #2': GenerationTurnsAdapter/ReviewPortAdapter both resolve the REAL per-run diff dynamically from ChangeAnalysisPort.classify() instead, since no per-run diff exists yet at composition-build time.",
    baseUrl: "supplied ONLY when app.dev?.baseUrl is present (asserted below as a present-when-given case).",
    testIdAttribute: "supplied ONLY when app.e2e?.testIdAttribute is present (asserted below as a present-when-given case) — deliberately NO 'data-testid' default applied here (the seed playwright.config.ts already defaults it); legitimately absent when the app declares none.",
    readSpecSource: "DELIBERATELY absent — the shell passes no spec reader. The composition root defaults to the confined reader (asserted below by reading real specs through the wired the authoring port), so FixLoop's Lever-2 selector-contradiction check still receives specSources on the real production path, and a path the agent reported is never read by a bare fs call that follows a symlink out of the spec directory.",
    stepLimitFor: "supplied ONLY when the host wires getAgentFacade: the per-run memo over the live runtime's step limits (asserted below as a present-when-given case that reaches the generation and review inputs). Legitimately absent when the host wires none: absent means no prompt of the run states a step limit, never a stand-in number.",
    setupCollaborators: "IS supplied — asserted below as a present case; listed here only because this describe-block enumerates the type's full optional-field set before splitting into present/allowlisted.",
    cleanupCollaborators: "IS supplied — asserted below as a present case.",
    groundingCollaborators: "IS supplied ({} — resolves to the real production default per this factory's own header) — asserted below as a present case.",
    reviewDomGroundingCollaborators: "IS supplied ({}) — asserted below as a present case.",
    serviceTopology: "supplied ONLY when app.services?.length && app.boundaries?.length are both present (asserted below as a present-when-given case, ADR-6) — legitimately absent for single-repo apps or apps that never declared a cross-service boundary profile. Mirrors the 'observer' precedent immediately below: supplied only when the caller/config provides it.",
    crossRepoImpact: "supplied ONLY under the SAME app.services?.length && app.boundaries?.length gate serviceTopology uses — legitimately absent for single-repo apps and apps with no declared boundary profile, or when the run's grounding.stitcher is false.",
    domPack: "IS supplied (defaulted true: run.grounding.domPack ?? app.qa.domPack ?? true) — asserted below as a present case.",
    versionUrl: "supplied ONLY when app.dev?.versionUrl is present — legitimately absent for a static site (no deploy gate).",
    versionReader: "DELIBERATELY absent — the run-orchestration composition defaults the reader of a declared source to the HTTP one; the host wires only what it overrides.",
    versionAncestry: "supplied ONLY when the run's own source (the primary's, or the trigger service's) declares a versionUrl — the mirror that relates what it serves to the run's sha.",
    deployGateIntervalMs: "IS supplied (defaulted via ?? DEFAULT) — asserted below as a present case.",
    deployGateTimeoutMs: "IS supplied (defaulted via ?? DEFAULT) — asserted below as a present case.",
    historyFilePath: "supplied ONLY as an explicit escape hatch (deps.historyFilePath) — production default path uses `runHistory` (SqliteRunHistoryAdapter) instead, asserted below.",
    runHistory: "IS supplied by default (SqliteRunHistoryAdapter) — asserted below as a present case; historyFilePath above is the opt-OUT alternative, mutually exclusive with this field.",
    observer: "supplied ONLY when the caller passes one — asserted below as a present-when-given case; legitimately absent for callers (tests, the F.2 operator) that omit it.",
    assembleChangeCoverage: "IS supplied (the value keystone) — asserted below as a present case.",
    baselineCases: "IS supplied ([]) — asserted below as a present case.",
    coverageBlocksForPublish: "IS supplied (false) — asserted below as a present case.",
    e2eChangedForPublish: "IS supplied (true) — asserted below as a present case.",
    reviewerApprovedForPublish: "IS supplied (true) — asserted below as a present case.",
    sanitize: "IS supplied (the real sanitizeText, a CRITICAL security invariant) — asserted below as a present case.",
    /* RedactionPortAdapter instance's containsSecret, wired alongside sanitize's own redact
       immediately above) — wired UNCONDITIONALLY, the SAME "IS supplied" precedent sanitize
       establishes. Asserted below as a present case.
     */
    containsSecret: "IS supplied (RedactionPortAdapter.containsSecret, wired alongside sanitize) — asserted below as a present case.",
    /* (a WriteConfinementAdapter wrapping realGit — local ops, NO auth decoration — + node:fs
       realpathSync/lstatSync) — asserted below as a present case, the SAME "IS supplied" precedent as
       sanitize/assembleChangeCoverage immediately above.
     */
    confinement: "IS supplied (WriteConfinementAdapter wrapping realGit + realpathSync/lstatSync) — asserted below as a present case.",
    /* (a ProcessAuditPortAdapter wrapping the learning repository's listRunOutcomes/listLearningRules reads + the
       2 sinks setRuleStatusByHuman/markContextStale) — wired UNCONDITIONALLY (fail-open
       fault isolation, not app-config gated), the SAME "IS supplied" precedent confinement
       establishes immediately above. Asserted below as a present case.
     */
    processAudit: "IS supplied (ProcessAuditPortAdapter wrapping learning repository reads + setRuleStatusByHuman/markContextStale sinks) — asserted below as a present case.",
    /* wrapping realGit's own local `git gc --auto --quiet`, no auth decoration) — wired
       UNCONDITIONALLY (fail-open fault isolation, not app-config gated), the SAME "IS supplied"
       precedent confinement/processAudit establish immediately above. Asserted below as a present case.
     */
    mirrorGc: "IS supplied (MirrorGcAdapter wrapping realGit's local `git gc --auto --quiet`) — asserted below as a present case.",
    codeGraph: "IS supplied for every app — the run's one code-graph adapter, indexed by the index phase and read by the structural signal and the cross-repo impact. Asserted below as a present-when-default case.",
    codeExplore: "IS supplied with codeGraph (the same code-graph adapter instance, so it reads the index the run built) — the lead's code-graph tool and the change dossier read it. Asserted below as a present-when-default case.",
    coChange: "IS supplied with codeGraph (GitCoChangeAdapter over the trusted git runner). Asserted below as a present-when-default case.",
    codeGraphMirrors: "Supplied ONLY under the gate serviceTopology uses (declared services and a boundary profile): the mirror of every declared service, for a cross-repo hop through a service the change did not reach. This fixture declares none, so it is absent.",
    codeGraphPrimary: "Supplied only on a service-triggered run (the primary repo, indexed too); this fixture is a same-repo run, so it is absent.",
    codeGraphRepoDir: "IS supplied (classify-source mirror: SERVICE on a webhook, PRIMARY otherwise) — pins CodeGraphPort.syncTo and StructuralSignalPortAdapter off workspace.mirrorDir on cross-repo runs. Asserted below as a present case.",
  };

  function fakeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      name: S("app.name"),
      repo: S("app.repo"),
      baseBranch: S("app.baseBranch"),
      dev: { baseUrl: S("app.dev.baseUrl"), versionUrl: S("app.dev.versionUrl") },
      e2e: { testIdAttribute: S("app.e2e.testIdAttribute") },
      qa: { needsReview: true, shadow: false },
      report: { onFailure: "issue" },
      ...overrides,
    } as unknown as AppConfig;
  }

  function fakeFactoryDeps(): RunEngineFactoryDeps {
    return { getAgentDeps: () => ({}) as unknown as AgentDeps };
  }

  test("buildEngineRootDeps supplies every non-optional EngineRootDeps field, and every optional field is either present-when-expected or documented in OPTIONAL_ALLOWLIST", () => {
    const cfg = buildEngineRootDeps(
      fakeAppConfig(),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff", guidance: S("run.guidance") },
    );

    const dyingLayer = "buildEngineRootDeps() -> EngineRootDeps (src/server/run-engine-factory.ts)";

    /* Non-optional fields — every one MUST be present (undefined fails these asserts loudly). */
    const nonOptional: Array<keyof typeof cfg> = [
      "repo", "appName", "mirrorDir", "e2eRelDir", "branch", "mode", "needsReview",
      "shadow", "onFailure", "maxRetries", "coveragePolicyMode", "vcs", "generationUseCase",
      "reviewRuntime", "validationStrategies", "executionStrategies", "objectiveSignal", "coveragePolicy",
      "githubPr", "githubIssue", "checkout",
    ];
    for (const field of nonOptional) {
      assert.notEqual(cfg[field], undefined, `${String(field)} (non-optional EngineRootDeps field) dropped at ${dyingLayer}`);
    }

    /* Optional fields this factory IS expected to populate given a fully-populated AppConfig. */
    assert.equal(cfg.guidance, S("run.guidance"), `guidance dropped at ${dyingLayer}`);
    assert.equal(cfg.baseUrl, S("app.dev.baseUrl"), `baseUrl dropped at ${dyingLayer} (the CRITICAL live-crash fix this fn's own header documents)`);
    assert.equal(cfg.testIdAttribute, S("app.e2e.testIdAttribute"), `testIdAttribute dropped at ${dyingLayer} (worst leak in audit-2026-07-flaky-selector-leaks)`);
    assert.ok(cfg.setupCollaborators?.e2e, `setupCollaborators dropped at ${dyingLayer}`);
    assert.ok(cfg.cleanupCollaborators?.e2e, `cleanupCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.groundingCollaborators, undefined, `groundingCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.reviewDomGroundingCollaborators, undefined, `reviewDomGroundingCollaborators dropped at ${dyingLayer}`);
    assert.equal(cfg.versionUrl, S("app.dev.versionUrl"), `versionUrl dropped at ${dyingLayer}`);
    assert.notEqual(cfg.versionAncestry, undefined, `versionAncestry dropped at ${dyingLayer}`);
    assert.equal(cfg.deployGateIntervalMs, 2000, `deployGateIntervalMs dropped/mis-defaulted at ${dyingLayer}`);
    assert.equal(cfg.deployGateTimeoutMs, 60000, `deployGateTimeoutMs dropped/mis-defaulted at ${dyingLayer}`);
    assert.notEqual(cfg.runHistory, undefined, `runHistory (SqliteRunHistoryAdapter default) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.assembleChangeCoverage, undefined, `assembleChangeCoverage (the value keystone) dropped at ${dyingLayer}`);
    assert.deepEqual(cfg.baselineCases, [], `baselineCases dropped at ${dyingLayer}`);
    assert.equal(cfg.coverageBlocksForPublish, false, `coverageBlocksForPublish dropped at ${dyingLayer}`);
    assert.equal(cfg.e2eChangedForPublish, true, `e2eChangedForPublish dropped at ${dyingLayer}`);
    assert.equal(cfg.reviewerApprovedForPublish, true, `reviewerApprovedForPublish dropped at ${dyingLayer}`);
    assert.notEqual(cfg.sanitize, undefined, `sanitize (CRITICAL security invariant) dropped at ${dyingLayer}`);
    /* containsSecret must be wired unconditionally alongside
       sanitize — the SAME "IS supplied" assertion pattern immediately above.
     */
    assert.notEqual(cfg.containsSecret, undefined, `containsSecret (logs→Issue egress boundary) dropped at ${dyingLayer}`);
    /* confinement must be wired unconditionally (fail-open
       fault isolation, not app-config gated) — the SAME "IS supplied" assertion pattern as sanitize
       immediately above.
     */
    assert.notEqual(cfg.confinement, undefined, `confinement (write-confinement wiring) dropped at ${dyingLayer}`);
    /* processAudit must be wired unconditionally (fail-
       open fault isolation, not app-config gated) — the SAME "IS supplied" assertion pattern as
       confinement immediately above.
     */
    assert.notEqual(cfg.processAudit, undefined, `processAudit (process-audit wiring) dropped at ${dyingLayer}`);
    /* mirrorGc must be wired unconditionally
       (fail-open fault isolation, not app-config gated) — the SAME "IS supplied" assertion pattern
       as confinement/processAudit immediately above.
     */
    assert.notEqual(cfg.mirrorGc, undefined, `mirrorGc (mirror-lifecycle wiring) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.codeExplore, undefined, `codeExplore (the lead's code-graph tool reads it, default mode signal) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.codeGraph, undefined, `codeGraph (the run's code graph, default mode signal) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.codeExplore, undefined, `codeExplore (the engine's explore over the run's index, default mode signal) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.coChange, undefined, `coChange (git co-change history, default mode signal) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.codeGraphRepoDir, undefined, `codeGraphRepoDir (classify-source mirror) dropped at ${dyingLayer}`);
    /* The shell supplies no spec reader: a bare readFile of an agent-reported path would follow a symlink the
       agent planted. The composition root's default (the confined reader) is asserted by the next test.
     */
    assert.equal(cfg.readSpecSource, undefined, `readSpecSource is supplied at ${dyingLayer}: the shell must pass none, so the composition root's confined reader is the only one`);

    /* Deliberately-absent-at-this-call optional fields (see OPTIONAL_ALLOWLIST for why). */
    assert.equal(cfg.diff, "", "diff is deliberately static '' at composition time — see OPTIONAL_ALLOWLIST.diff");
    assert.equal(cfg.domPack, true, "domPack is defaulted true at composition time — see OPTIONAL_ALLOWLIST.domPack");
    assert.equal(cfg.historyFilePath, undefined, "historyFilePath is the opt-OUT alternative to runHistory — absent by default, see OPTIONAL_ALLOWLIST.historyFilePath");
    assert.equal(cfg.observer, undefined, "observer is absent because this call omitted the 5th argument — see OPTIONAL_ALLOWLIST.observer");
  });

  /* The spec reader is the composition root's own: the shell hands it none (asserted above), so what Lever-2 reads
     is whatever the root defaults to, observed here through the wired the authoring port with real files. */
  test("the composition root reads the delivered specs through the confined reader: a spec inside the spec directory is a source, and a symlink that leaves it is refused", async () => {
    const mirrorRoot = mkdtempSync(join(tmpdir(), "qa-seam-confined-reader-"));
    try {
      const cfg = buildEngineRootDeps(fakeAppConfig(), { ...fakeFactoryDeps(), mirrorRoot }, S("namespace"), { mode: "diff" });
      const specDir = join(cfg.mirrorDir, cfg.e2eRelDir);
      mkdirSync(join(specDir, "flows"), { recursive: true });
      writeFileSync(join(specDir, "flows", "inside.spec.ts"), "// inside the spec directory\n");
      writeFileSync(join(mirrorRoot, "secret.txt"), "TOP SECRET");
      symlinkSync(join(mirrorRoot, "secret.txt"), join(specDir, "flows", "leak.spec.ts"));

      const delivering = (specs: string[]): EngineRootDeps => ({
        ...cfg,
        generationUseCase: { author: async () => ({ specs, end: GENERATION_END.DELIVERED }) },
      });

      const inside = await wireEngine(delivering(["flows/inside.spec.ts"])).generation.author(specDir);
      assert.deepEqual(inside.specSources, ["// inside the spec directory\n"]);

      await assert.rejects(
        wireEngine(delivering(["flows/leak.spec.ts"])).generation.author(specDir),
        (err: unknown) => err instanceof ConfinedPathError && err.path === "flows/leak.spec.ts",
      );
    } finally {
      rmSync(mirrorRoot, { recursive: true, force: true });
    }
  });

  /* The limit each role runs under is read by the shell from the live runtime and handed to the engine as a
     resolver; the composition root gives it to the adapters. Observed here at the use case and at the review prompt
     rendering, the two places a prompt is built from. With no facade wired there is no resolver, and so no limit. */
  function facadeReporting(limits: StepLimits): AgentFacade {
    const assignment = { provider: "opencode" as const, model: S("model") };
    return {
      config: { assignments: { primary: assignment, reviewer: assignment, chat: assignment } },
      deps: () => ({}) as unknown as AgentDeps,
      getStatus: async () => ({ providers: [] }),
      listModels: async () => [],
      stepLimits: async () => limits,
    };
  }

  async function inputsBuiltThrough(deps: RunEngineFactoryDeps): Promise<{ cfg: EngineRootDeps; generation: OpencodeRunInput; review: ReviewInput }> {
    const cfg = buildEngineRootDeps(fakeAppConfig(), deps, S("namespace"), { mode: "diff" });
    const generated: OpencodeRunInput[] = [];
    const reviewed: ReviewInput[] = [];
    const adapters = wireEngine({
      ...cfg,
      generationUseCase: {
        author: async (input) => {
          generated.push(input);
          return { specs: [], end: GENERATION_END.DELIVERED };
        },
      },
      reviewRuntime: {
        runtime: { openSession: async () => ({ prompt: async () => ({ output: "" }), dispose: async () => {} }) },
        rendering: {
          renderReviewer: (input) => {
            reviewed.push(input);
            return { text: "", sectionSizes: {} };
          },
        },
        verdicts: { parseReview: () => ({ approved: true, findings: [], parsed: true, valid: true, issues: [] }) },
      },
    });
    const specDir = join(cfg.mirrorDir, cfg.e2eRelDir);
    await adapters.generation.author(specDir);
    await adapters.review.review(specDir, []);
    assert.ok(generated[0] && reviewed[0], "both prompts were built");
    return { cfg, generation: generated[0], review: reviewed[0] };
  }

  test("the step limit of each role crosses the composition root: the generator's reaches the generation input and the reviewer's the review input", async () => {
    const { cfg, generation, review } = await inputsBuiltThrough({ ...fakeFactoryDeps(), getAgentFacade: () => facadeReporting({ author: 41, reviewer: 17 }) });

    const dyingLayer = "buildEngineRootDeps() -> wireEngine() (src/server/run-engine-factory.ts -> engine-root.ts)";
    assert.notEqual(cfg.stepLimitFor, undefined, `stepLimitFor dropped at ${dyingLayer}`);
    assert.equal(generation.stepLimit, 41, `the generator's limit dropped at ${dyingLayer}`);
    assert.equal(review.stepLimit, 17, `the reviewer's limit dropped at ${dyingLayer}`);
  });

  test("with no facade wired there is no resolver and no limit on any input (absent means no statement, never a stand-in)", async () => {
    const { cfg, generation, review } = await inputsBuiltThrough(fakeFactoryDeps());

    assert.equal(cfg.stepLimitFor, undefined);
    assert.equal("stepLimit" in generation, false);
    assert.equal("stepLimit" in review, false);
  });

  /* The real facade over two runtimes (the second a stand-in for one a future provider adds), with only the providers themselves faked. A provider that enforces no
     step limit it can report leaves its roles without one, all the way to the input a prompt is built from. */
  function providerReporting(provider: AgentProvider, limits?: StepLimits): AgentRuntimeStrategy {
    return {
      provider,
      health: async () => ({ provider, status: "healthy", configured: true }),
      listModels: async () => [],
      openSession: async () => {
        throw new Error("no session in a seam test");
      },
      ...(limits ? { stepLimits: async () => limits } : {}),
    };
  }
  const assignedTo = (provider: AgentProvider) => ({ provider, model: S("model") });
  const NO_LIMIT_NAME = "fixture-runtime";
  const NO_LIMIT_RUNTIME = NO_LIMIT_NAME as unknown as AgentProvider;

  test("a runtime that enforces no limit for a role gives that role none end to end: a runtime alone has none, and with the reviewer on it only the generator keeps OpenCode's", async () => {
    const runtimeAlone = new AgentRuntimeFacade({ [NO_LIMIT_NAME]: providerReporting(NO_LIMIT_RUNTIME) } as unknown as Record<AgentProvider, AgentRuntimeStrategy>, {
      assignments: { primary: assignedTo(NO_LIMIT_RUNTIME), reviewer: assignedTo(NO_LIMIT_RUNTIME), chat: assignedTo(NO_LIMIT_RUNTIME) },
    });
    const split = new AgentRuntimeFacade(
      { opencode: providerReporting("opencode", { author: 41, reviewer: 17 }), [NO_LIMIT_NAME]: providerReporting(NO_LIMIT_RUNTIME) } as Record<AgentProvider, AgentRuntimeStrategy>,
      { assignments: { primary: assignedTo("opencode"), reviewer: assignedTo(NO_LIMIT_RUNTIME), chat: assignedTo(NO_LIMIT_RUNTIME) } },
    );

    const alone = await inputsBuiltThrough({ ...fakeFactoryDeps(), getAgentFacade: () => runtimeAlone });
    assert.equal("stepLimit" in alone.generation, false);
    assert.equal("stepLimit" in alone.review, false);

    const dual = await inputsBuiltThrough({ ...fakeFactoryDeps(), getAgentFacade: () => split });
    assert.equal(dual.generation.stepLimit, 41);
    assert.equal("stepLimit" in dual.review, false, "the reviewer runs on a runtime with no limit to report: OpenCode's figure for that role is not its own");
  });

  test("every documented OPTIONAL_ALLOWLIST field is a REAL optional field on the type (guards against a stale allowlist entry after a refactor)", () => {
    const cfg = buildEngineRootDeps(fakeAppConfig(), fakeFactoryDeps(), S("namespace"), { mode: "diff" });
    for (const field of Object.keys(OPTIONAL_ALLOWLIST)) {
      assert.ok(field in cfg || cfg[field as keyof typeof cfg] === undefined, `OPTIONAL_ALLOWLIST references '${field}', which is not a real field on the returned EngineRootDeps object shape — stale allowlist entry`);
    }
  });

  test("buildEngineRootDeps leaves guidance/testIdAttribute/versionUrl/observer absent when the AppConfig/caller omits them (never fabricated)", () => {
    const cfg = buildEngineRootDeps(
      fakeAppConfig({ dev: { baseUrl: "https://dev.example.test" }, e2e: undefined } as Partial<AppConfig>),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff" },
    );
    assert.equal(cfg.guidance, undefined);
    assert.equal(cfg.testIdAttribute, undefined);
    assert.equal(cfg.versionUrl, undefined);
    assert.equal(cfg.versionAncestry, undefined);
    assert.equal(cfg.observer, undefined);
  });

  /* An e2e-target run without dev.baseUrl is a config defect — the factory must throw at
     composition time (before any git clone/agent session/Playwright spawn is spent), not at
     E2eExecutionStrategy.run() deep inside the use-case.
   */
  /* The harness facts the generator is told about its suite start at the app's own config: the test-id
     attribute declared in AppConfig must survive the composition seam and reach the grounding adapter's
     facts, with the fixtures read from the run's own spec directory. */
  test("an app's declared testIdAttribute reaches the harness facts through the composition seam, and none is invented when the app declares none", async () => {
    const specDir = mkdtempSync(join(tmpdir(), "qa-seam-facts-"));
    writeFileSync(join(specDir, "fixtures.ts"), "export const test = 1;\nexport function authenticate() {}\n");
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const factsFor = async (app: AppConfig): Promise<unknown> => {
        const cfg = buildEngineRootDeps(app, fakeFactoryDeps(), S("namespace"), { mode: "diff" });
        const grounding = wireEngine(cfg).preGenerationGrounding;
        assert.ok(grounding, "an e2e app is composed with a pre-generation grounding port");
        return (await grounding.ground(specDir)).harnessFacts;
      };

      const declared = "data-seam-sentinel-attr";
      assert.deepEqual(await factsFor(fakeAppConfig({ e2e: { testIdAttribute: declared } } as Partial<AppConfig>)), {
        testIdAttribute: declared,
        fixtures: { file: "fixtures.ts", exports: ["test", "authenticate"], signatures: ["export function authenticate()"] },
      });
      assert.deepEqual(await factsFor(fakeAppConfig({ e2e: {} } as Partial<AppConfig>)), {
        fixtures: { file: "fixtures.ts", exports: ["test", "authenticate"], signatures: ["export function authenticate()"] },
      });
    } finally {
      warn.mock.restore();
      rmSync(specDir, { recursive: true, force: true });
    }
  });
});
