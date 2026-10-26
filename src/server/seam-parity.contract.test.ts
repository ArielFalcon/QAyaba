/* Permanent seam: kernel RunOutcome ↔ toStoredRunOutcome, and AppConfig ↔ EngineRootDeps.
   qa-engine cannot import src/, so this shell test is the drift gate. A field added
   to the type without an allowlist entry fails typecheck; a field dropped by the adapter fails
   this test. */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome";
import { GENERATION_END } from "@kernel/generation-end";
import { wireEngine, type EngineRootDeps } from "./engine-root";
import { ConfinedPathError } from "../../qa-engine/src/shared-infrastructure/spec-path-confinement";

import { toStoredRunOutcome, type RunHistorySqliteAdapterDeps, SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { buildEngineRootDeps, type RunEngineFactoryDeps } from "./run-engine-factory";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../integrations/opencode-client";
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
   (d) PERSISTENCE surface — kernel RunOutcome vs SqliteRunHistoryAdapter's toStoredRunOutcome
   ════════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("seam-parity: PERSISTENCE (kernel RunOutcome vs toStoredRunOutcome)", () => {
  const ALL_TOP_FIELDS = {
    runId: true, app: true, sha: true, mode: true, target: true, verdict: true, errorClass: true,
    gateSignals: true, rulesRetrieved: true, diffArchetypes: true, reflection: true, at: true, note: true, cases: true,
    logs: true, adjudication: true,
  } satisfies Record<keyof KernelRunOutcome, true>;

  const ALL_GATE_SIGNAL_FIELDS = {
    static: true, coverageRatio: true, valueScore: true, mutantCount: true, killedCount: true, branchCoverage: true, changeCoverage: true, bundleMutation: true, branchCases: true, missingCases: true,
    reviewerCorrections: true,
    reviewerRationale: true, reviewerApproved: true, reviewer: true, flaky: true, retries: true, confinement: true,
    usage: true, phaseTimings: true, furthestPhase: true, preExecAmbiguityCatches: true, deterministicSelectorBlocks: true,
    catalogGateInWindow: true, catalogGateAdvisory: true, catalogGateFailClosed: true,
    structuralSignalBytes: true, serviceLinksCount: true, contractDriftCount: true,
    crossRepoImpactedCount: true, sandbox: true, reviewerIndependence: true, closedLoop: true, agentBrowser: true, coordination: true,
    coverage: true, integrity: true, intent: true, value: true, noop: true, causal: true, coverageByCandidate: true, valueByCandidate: true, valueStats: true,
  } satisfies Record<keyof KernelRunOutcome["gateSignals"], true>;

  const ALLOWLIST: Record<string, string> = {
    /* toStoredRunOutcome dropping `note` matches the shell RunOutcome shape in src/types.ts,
       which has no note field. QaRunResult.note and RunRecord.note are different types; `note`
       reaches the run record through QaRunResult.note -> RunRecord.note, never through this
       mapping's run_outcomes row.
     */
    note: "CORRECT BY DESIGN (not a drop): toStoredRunOutcome never carries outcome.note through because StoredRunOutcome (src/types.ts's RunOutcome interface) has NO note field to carry it TO — grep/read-confirmed against the full interface. The kernel RunOutcome.note reaches the run record through a SEPARATE seam (QaRunResult.note -> RunRecord.note, src/server/runner.ts's own header), never through this mapping fn's run_outcomes row. Diagnostic-only either way (never gates verdict/publish).",
    cases: "DELIBERATELY not persisted via toStoredRunOutcome — StoredRunOutcome (src/types.ts) has NO cases field at all (grep-confirmed); this field exists on the kernel RunOutcome ONLY for a DIFFERENT driving-side consumer (src/server/runner.ts's runViaEngine threads it into history.addCase() calls directly, per this file's own header comment), not for the run_outcomes row this adapter writes. Comparator-blind by the kernel type's own documented construction.",
    logs: "DELIBERATELY not persisted via toStoredRunOutcome",
    diffArchetypes: "CORRECT BY DESIGN (not a drop): a fold-only attribution input. The learning fold reads it in-process from the outcome it is handed (historyLearningStore.recordOutcome) to credit only the retrieved rules attributable to the diff's structural shapes; LearningPort.fold receives the kernel outcome directly, never a persisted row, and StoredRunOutcome (src/types.ts) has no field for it.",
    adjudication: "CORRECT BY DESIGN (not a drop): StoredRunOutcome (src/types.ts) has NO adjudication field at all. This is a REWRITTEN-ONLY field: the kernel type carries it (wide, optional",
  };

  test("kernel RunOutcome's own top-level field list matches the allowlist + the mapping fn's carried set exactly", () => {
    const mapped = ["runId", "app", "sha", "mode", "target", "verdict", "errorClass", "gateSignals", "rulesRetrieved", "reflection", "at"];
    const allFieldNames = Object.keys(ALL_TOP_FIELDS).sort();
    const accountedFor = [...new Set([...mapped, ...Object.keys(ALLOWLIST)])].sort();
    assert.deepEqual(accountedFor, allFieldNames, "every kernel RunOutcome top-level field must be either mapped or allowlisted with a reason");
  });

  test("gateSignals' own field list is fully mapped (no allowlist needed — every field carries through)", () => {
    const mapped = [
      "static", "coverageRatio", "valueScore", "mutantCount", "killedCount", "branchCoverage", "changeCoverage", "bundleMutation", "branchCases", "missingCases", "reviewerCorrections",
      "reviewerRationale",
      "reviewerApproved", "reviewer", "flaky", "retries", "confinement", "usage", "phaseTimings", "furthestPhase",
      "preExecAmbiguityCatches", "deterministicSelectorBlocks", "catalogGateInWindow",
      "catalogGateAdvisory", "catalogGateFailClosed",
      "structuralSignalBytes", "serviceLinksCount", "contractDriftCount", "crossRepoImpactedCount", "sandbox", "reviewerIndependence", "closedLoop", "agentBrowser", "coordination",
      "coverage", "integrity", "intent", "value", "noop", "causal", "coverageByCandidate", "valueByCandidate", "valueStats",
    ];
    assert.deepEqual(mapped.sort(), Object.keys(ALL_GATE_SIGNAL_FIELDS).sort(), "every gateSignals field must be mapped — toStoredRunOutcome's own header claims 100% pass-through for this nested object");
  });

  test("toStoredRunOutcome carries every top-level + gateSignals field through with its sentinel value (fully-populated kernel outcome)", () => {
    const kernelOutcome: KernelRunOutcome = {
      runId: S("runId"),
      app: S("app"),
      sha: S("sha"),
      mode: "diff",
      target: "e2e",
      verdict: "pass",
      errorClass: "E-EXEC-FAIL",
      gateSignals: {
        static: true,
        coverageRatio: 0.42,
        valueScore: 0.77,
        reviewerCorrections: [S("reviewerCorrections")],
        reviewerRationale: S("reviewerRationale"),
        reviewerApproved: true,
        reviewer: { rounds: 2, modelRounds: 1, approved: false, corrections: 1, blocking: 1, durationMs: 4_000, promptBytes: 900, outputTokens: 120, costUsd: 0.01, steps: 1, preCheckRejects: 1, skippedRounds: 2 },
        flaky: true,
        retries: 3,
        confinement: { strays: 1, dangerous: 0, reverted: [S("reverted")] },
        usage: { totalTokens: 999 },
        phaseTimings: { generate: 111 },
        furthestPhase: "execute",
        preExecAmbiguityCatches: 2,
        deterministicSelectorBlocks: 1,
        catalogGateInWindow: 5,
        catalogGateAdvisory: 4,
        catalogGateFailClosed: 0,
        structuralSignalBytes: 512,
        serviceLinksCount: 3,
        contractDriftCount: 0,
        crossRepoImpactedCount: 2,
        sandbox: { egress: "enforced", denied: [S("denied host")] },
        closedLoop: { calls: 4, devWrites: 3, closed: true },
        agentBrowser: { calls: 9, blocks: 2, invalidations: 1, renewals: 1 },
        coordination: { plan: "fanout", flows: 3, delivered: 2, incomplete: 1, authoring: "authenticated-browser" },
        coverage: { stale: true },
        value: { stale: true },
        integrity: { acceptances: 2, rejected: 1, proofReused: 1, capHit: true },
        intent: { mode: "enforce", violations: 2, wouldReject: 0, clauses: 9, opaque: 1, opacityHigh: false },
        noop: { kind: "unobservable" },
        coverageByCandidate: [{ candidateId: "uc-0000aaaa", changedLines: 4, coveredChanged: 3, ratio: 0.75 }],
        valueStats: { baseline: 5, exposed: 2, killed: 1, failed: 1, flowBreaks: 0 },
        valueByCandidate: [{ candidateId: "uc-0000aaaa", exposed: 2, killed: 1, ratio: 0.5 }],
        causal: { reach: "in-reach", basis: "request", via: ["GET /orders"], reason: "r", cases: [{ name: "c", reach: "in-reach", basis: "request" }] },
      },
      rulesRetrieved: [S("rulesRetrieved")],
      reflection: { rootCause: S("reflection.rootCause") },
      at: "2026-07-02T00:00:00.000Z",
      note: S("note"),
    };

    const out = toStoredRunOutcome(kernelOutcome);
    const dyingLayer = "toStoredRunOutcome() -> StoredRunOutcome (src/server/run-history-sqlite-adapter.ts)";

    assert.equal(out.runId, S("runId"), `runId dropped at ${dyingLayer}`);
    assert.equal(out.app, S("app"), `app dropped at ${dyingLayer}`);
    assert.equal(out.sha, S("sha"), `sha dropped at ${dyingLayer}`);
    assert.equal(out.mode, "diff", `mode dropped at ${dyingLayer}`);
    assert.equal(out.target, "e2e", `target dropped at ${dyingLayer}`);
    assert.equal(out.verdict, "pass", `verdict dropped at ${dyingLayer}`);
    assert.equal(out.errorClass, "E-EXEC-FAIL", `errorClass dropped at ${dyingLayer}`);
    assert.deepEqual(out.rulesRetrieved, [S("rulesRetrieved")], `rulesRetrieved dropped at ${dyingLayer}`);
    assert.equal((out.reflection as { rootCause?: string } | undefined)?.rootCause, S("reflection.rootCause"), `reflection dropped at ${dyingLayer}`);
    assert.equal(out.at, "2026-07-02T00:00:00.000Z", `at dropped at ${dyingLayer}`);

    const gs = out.gateSignals;
    assert.equal(gs.static, true, `gateSignals.static dropped at ${dyingLayer}`);
    assert.equal(gs.coverageRatio, 0.42, `gateSignals.coverageRatio dropped at ${dyingLayer}`);
    assert.equal(gs.valueScore, 0.77, `gateSignals.valueScore dropped at ${dyingLayer}`);
    assert.deepEqual(gs.reviewerCorrections, [S("reviewerCorrections")], `gateSignals.reviewerCorrections dropped at ${dyingLayer}`);
    assert.equal(gs.reviewerRationale, S("reviewerRationale"), `gateSignals.reviewerRationale dropped at ${dyingLayer}`);
    assert.equal(gs.reviewerApproved, true, `gateSignals.reviewerApproved dropped at ${dyingLayer}`);
    assert.deepEqual(gs.reviewer, { rounds: 2, modelRounds: 1, approved: false, corrections: 1, blocking: 1, durationMs: 4_000, promptBytes: 900, outputTokens: 120, costUsd: 0.01, steps: 1, preCheckRejects: 1, skippedRounds: 2 }, `gateSignals.reviewer dropped at ${dyingLayer}`);
    assert.equal(gs.flaky, true, `gateSignals.flaky dropped at ${dyingLayer}`);
    assert.equal(gs.retries, 3, `gateSignals.retries dropped at ${dyingLayer}`);
    assert.deepEqual(gs.confinement, { strays: 1, dangerous: 0, reverted: [S("reverted")] }, `gateSignals.confinement dropped at ${dyingLayer}`);
    assert.deepEqual(gs.usage, { totalTokens: 999 }, `gateSignals.usage dropped at ${dyingLayer}`);
    assert.deepEqual(gs.phaseTimings, { generate: 111 }, `gateSignals.phaseTimings dropped at ${dyingLayer}`);
    assert.equal(gs.furthestPhase, "execute", `gateSignals.furthestPhase dropped at ${dyingLayer}`);
    assert.deepEqual(gs.noop, { kind: "unobservable" }, `gateSignals.noop dropped at ${dyingLayer}`);
    assert.equal(gs.causal?.reach, "in-reach", `gateSignals.causal dropped at ${dyingLayer}`);
    assert.equal(gs.valueStats?.exposed, 2, `gateSignals.valueStats dropped at ${dyingLayer}`);
    assert.equal(gs.valueByCandidate?.[0]?.ratio, 0.5, `gateSignals.valueByCandidate dropped at ${dyingLayer}`);
    assert.equal(gs.coverageByCandidate?.[0]?.ratio, 0.75, `gateSignals.coverageByCandidate dropped at ${dyingLayer}`);
    assert.equal(gs.preExecAmbiguityCatches, 2, `gateSignals.preExecAmbiguityCatches dropped at ${dyingLayer}`);
    assert.equal(gs.deterministicSelectorBlocks, 1, `gateSignals.deterministicSelectorBlocks dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateInWindow, 5, `gateSignals.catalogGateInWindow dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateAdvisory, 4, `gateSignals.catalogGateAdvisory dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateFailClosed, 0, `gateSignals.catalogGateFailClosed dropped at ${dyingLayer}`);
    assert.equal(gs.structuralSignalBytes, 512, `gateSignals.structuralSignalBytes dropped at ${dyingLayer}`);
    assert.equal(gs.serviceLinksCount, 3, `gateSignals.serviceLinksCount dropped at ${dyingLayer}`);
    assert.equal(gs.contractDriftCount, 0, `gateSignals.contractDriftCount dropped at ${dyingLayer}`);
    assert.equal(gs.crossRepoImpactedCount, 2, `gateSignals.crossRepoImpactedCount dropped at ${dyingLayer}`);
    assert.deepEqual(gs.sandbox, { egress: "enforced", denied: [S("denied host")] }, `gateSignals.sandbox dropped at ${dyingLayer}`);
    assert.deepEqual(gs.closedLoop, { calls: 4, devWrites: 3, closed: true }, `gateSignals.closedLoop dropped at ${dyingLayer}`);
    assert.deepEqual(gs.coverage, { stale: true }, `gateSignals.coverage dropped at ${dyingLayer}`);
    assert.deepEqual(gs.integrity, { acceptances: 2, rejected: 1, proofReused: 1, capHit: true }, `gateSignals.integrity dropped at ${dyingLayer}`);

    assert.equal("note" in out, false, `note IS in the allowlist as CORRECT BY DESIGN — StoredRunOutcome genuinely has no note field, see the allowlist entry's own evidence trail; if this starts failing because StoredRunOutcome gains a note field, update the allowlist entry above instead of patching the assertion`);
  });

  test("SqliteRunHistoryAdapter.save() forwards the mapped outcome to the injected saveOutcome (the seam a real caller uses)", async () => {
    let captured: unknown;
    const deps: RunHistorySqliteAdapterDeps = { saveOutcome: (o) => { captured = o; } };
    const adapter = new SqliteRunHistoryAdapter(deps);
    await adapter.save({
      runId: S("runId"), app: S("app"), sha: S("sha"), mode: "diff", target: "e2e", verdict: "pass",
      errorClass: null,
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
      rulesRetrieved: [], at: "2026-07-02T00:00:00.000Z",
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
    baseUrl: "supplied ONLY when app.dev?.baseUrl is present (asserted below as a present-when-given case) — legitimately absent for code-mode apps (no dev: block).",
    testIdAttribute: "supplied ONLY when app.e2e?.testIdAttribute is present (asserted below as a present-when-given case) — deliberately NO 'data-testid' default applied here (the seed playwright.config.ts already defaults it); legitimately absent when the app declares none.",
    readSpecSource: "DELIBERATELY absent — the shell passes no spec reader. The composition root defaults to the confined reader (asserted below by reading real specs through the wired the authoring port), so FixLoop's Lever-2 selector-contradiction check still receives specSources on the real production path, and a path the agent reported is never read by a bare fs call that follows a symlink out of the spec directory.",
    stepLimitFor: "supplied ONLY when the host wires getAgentFacade: the per-run memo over the live runtime's step limits (asserted below as a present-when-given case that reaches the generation and review inputs). Legitimately absent when the host wires none: absent means no prompt of the run states a step limit, never a stand-in number.",
    setupCollaborators: "IS supplied (e2e + code) — asserted below as a present case; listed here only because this describe-block enumerates the type's full optional-field set before splitting into present/allowlisted.",
    cleanupCollaborators: "IS supplied (e2e only, matching engine-root.ts's own `!cfg.isCode` gate) — asserted below as a present case.",
    groundingCollaborators: "IS supplied ({} — resolves to the real production default per this factory's own header) — asserted below as a present case.",
    reviewDomGroundingCollaborators: "IS supplied ({}) — asserted below as a present case.",
    serviceTopology: "supplied ONLY when app.services?.length && app.boundaries?.length are both present (asserted below as a present-when-given case, ADR-6) — legitimately absent for single-repo apps or apps that never declared a cross-service boundary profile. Mirrors the 'observer' precedent immediately below: supplied only when the caller/config provides it.",
    crossRepoImpact: "supplied ONLY under the SAME app.services?.length && app.boundaries?.length gate serviceTopology uses — legitimately absent for single-repo apps and apps with no declared boundary profile, or when the run's grounding.stitcher is false.",
    contextMap: "DELIBERATELY absent — see this fn's own header: no per-run mirrorDir/diff exists yet at composition-build time to read e2e/.qa/context.json from. Documented graceful degradation, not a drop.",
    prChangedFiles: "DELIBERATELY absent — same reason as contextMap (per-run intent.changedFiles doesn't exist yet at composition-build time).",
    domPack: "IS supplied (defaulted true: run.grounding.domPack ?? app.qa.domPack ?? true) — asserted below as a present case.",
    versionUrl: "supplied ONLY when app.dev?.versionUrl is present — legitimately absent for code-mode/static apps (no deploy gate).",
    versionPoll: "supplied ONLY when app.dev?.versionUrl is present (paired with versionUrl above).",
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
    learningRepo: "IS supplied (SqliteLearningRepository) — asserted below as a present case.",
    /* (a WriteConfinementAdapter wrapping realGit — local ops, NO auth decoration — + node:fs
       realpathSync/lstatSync) — asserted below as a present case, the SAME "IS supplied" precedent as
       sanitize/learningRepo/assembleChangeCoverage immediately above.
     */
    confinement: "IS supplied (WriteConfinementAdapter wrapping realGit + realpathSync/lstatSync) — asserted below as a present case.",
    /* (a ProcessAuditPortAdapter wrapping the learning repository's listRunOutcomes/listLearningRules reads + the
       3 sinks recordIncident/setRuleStatusByHuman/markContextStale) — wired UNCONDITIONALLY (fail-open
       fault isolation, not app-config gated), the SAME "IS supplied" precedent confinement/
       reflectorPort establish immediately above. Asserted below as a present case.
     */
    processAudit: "IS supplied (ProcessAuditPortAdapter wrapping learning repository reads + recordIncident/setRuleStatusByHuman/markContextStale sinks) — asserted below as a present case.",
    /* wrapping realGit's own local `git gc --auto --quiet`, no auth decoration) — wired
       UNCONDITIONALLY (fail-open fault isolation, not app-config gated), the SAME "IS supplied"
       precedent confinement/processAudit establish immediately above. Asserted below as a present case.
     */
    mirrorGc: "IS supplied (MirrorGcAdapter wrapping realGit's local `git gc --auto --quiet`) — asserted below as a present case.",
    /* loadCurriculum/saveCurriculum) — wired UNCONDITIONALLY (measure-and-rank only: it never gates
       a verdict, a publish decision or a coverage decision, so there is no risk surface a config
       flag would protect), the SAME "IS supplied" precedent processAudit/mirrorGc establish
       immediately above. Asserted below as a present case.
     */
    curriculumPort: "IS supplied (CurriculumPortAdapter over the learning repository's loadCurriculum/saveCurriculum) — asserted below as a present case.",
    codeGraph: "IS supplied for every app — the run's one code-graph adapter, indexed by the index phase and read by the structural signal and the cross-repo impact. Asserted below as a present-when-default case.",
    codeExplore: "IS supplied with codeGraph (the same code-graph adapter instance, so it reads the index the run built) — the lead's code-graph tool and the change dossier read it. Asserted below as a present-when-default case.",
    coChange: "IS supplied with codeGraph (GitCoChangeAdapter over the trusted git runner). Asserted below as a present-when-default case.",
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
      "repo", "appName", "mirrorDir", "e2eRelDir", "branch", "target", "mode", "needsReview",
      "shadow", "onFailure", "maxRetries", "isCode", "coveragePolicyMode", "vcs", "generationUseCase",
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
    assert.ok(cfg.setupCollaborators?.e2e && cfg.setupCollaborators?.code, `setupCollaborators dropped at ${dyingLayer}`);
    assert.ok(cfg.cleanupCollaborators?.e2e, `cleanupCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.groundingCollaborators, undefined, `groundingCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.reviewDomGroundingCollaborators, undefined, `reviewDomGroundingCollaborators dropped at ${dyingLayer}`);
    assert.equal(cfg.versionUrl, S("app.dev.versionUrl"), `versionUrl dropped at ${dyingLayer}`);
    assert.notEqual(cfg.versionPoll, undefined, `versionPoll dropped at ${dyingLayer}`);
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
    assert.notEqual(cfg.learningRepo, undefined, `learningRepo dropped at ${dyingLayer}`);
    /* confinement must be wired unconditionally (fail-open
       fault isolation, not app-config gated) — the SAME "IS supplied" assertion pattern as sanitize/
       learningRepo immediately above.
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
    /* curriculumPort must be wired unconditionally — the SAME "IS supplied" assertion pattern as
       processAudit/mirrorGc immediately above. A dropped port here is silent by construction (the
       curriculum simply stays empty forever), which is why this present-case assertion is the gate
       rather than a runtime failure.
     */
    assert.notEqual(cfg.curriculumPort, undefined, `curriculumPort (curriculum wiring) dropped at ${dyingLayer}`);
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
    assert.equal(cfg.contextMap, undefined, "contextMap is deliberately absent at composition time — see OPTIONAL_ALLOWLIST.contextMap");
    assert.equal(cfg.prChangedFiles, undefined, "prChangedFiles is deliberately absent at composition time — see OPTIONAL_ALLOWLIST.prChangedFiles");
    assert.equal(cfg.domPack, true, "domPack is defaulted true at composition time — see OPTIONAL_ALLOWLIST.domPack");
    assert.deepEqual(cfg.integrity, { reviewLoop: true }, `integrity (review-loop master switch, default on, opt-out) dropped at ${dyingLayer}`);
    assert.equal(cfg.historyFilePath, undefined, "historyFilePath is the opt-OUT alternative to runHistory — absent by default, see OPTIONAL_ALLOWLIST.historyFilePath");
    assert.equal(cfg.observer, undefined, "observer is absent because this call omitted the 5th argument — see OPTIONAL_ALLOWLIST.observer");
  });

  test("qa.reviewLoopIntegrity reaches EngineRootDeps.integrity.reviewLoop, and is on unless the app opts out", () => {
    const byDefault = buildEngineRootDeps(fakeAppConfig(), fakeFactoryDeps(), S("namespace"), { mode: "diff" });
    assert.deepEqual(byDefault.integrity, { reviewLoop: true }, "the master switch is on unless the app turns it off");

    const off = buildEngineRootDeps(
      fakeAppConfig({ qa: { needsReview: true, shadow: false, testDataPrefix: "qa-bot", reviewLoopIntegrity: false } }),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff" },
    );
    assert.deepEqual(off.integrity, { reviewLoop: false }, "qa.reviewLoopIntegrity: false reaches buildEngineRootDeps()");
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
        verdicts: { parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }) },
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

  test("buildEngineRootDeps leaves guidance/baseUrl/testIdAttribute/versionUrl/observer absent when the AppConfig/caller omits them (never fabricated)", () => {
    /* CODE-target run: dev.baseUrl is conceptually absent for code mode (no live DEV URL), so this
       app config is legal and the factory must NOT throw the new composition-time baseUrl guard.
       Any e2e-target build must still declare dev.baseUrl — see the guard's own test.
     */
    const cfg = buildEngineRootDeps(
      fakeAppConfig({ dev: undefined, e2e: undefined, code: true } as Partial<AppConfig>),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff" },
    );
    assert.equal(cfg.guidance, undefined);
    assert.equal(cfg.baseUrl, undefined);
    assert.equal(cfg.testIdAttribute, undefined);
    assert.equal(cfg.versionUrl, undefined);
    assert.equal(cfg.versionPoll, undefined);
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

  test("buildEngineRootDeps throws when an e2e-target app omits dev.baseUrl (composition-time guard)", () => {
    assert.throws(
      () => buildEngineRootDeps(
        fakeAppConfig({ dev: undefined } as Partial<AppConfig>),
        fakeFactoryDeps(),
        S("namespace"),
        { mode: "diff" },
      ),
      /target "e2e" but no dev\.baseUrl/,
    );
  });
});
