/*
 * Composition root: maps AppConfig into a qa-engine CompositionConfig and returns
 * buildProduction(...). Wires host collaborators (agent runtime, GitHub, runners).
 * Env reads for execution timeouts stay here. Agent remains read-only on watched repos.
 */

import { join, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, realpathSync, lstatSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AppConfig } from "../orchestrator/config-loader";
import { resolveValueOraclePolicy } from "../orchestrator/schemas";
import type { AgentDeps } from "../integrations/opencode-client";
import { REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, agentTimeout } from "../integrations/opencode-client";

import {
  withUsageSink,
  withStallWatchdog,
  withSessionRegistration,
  registerRunSession,
  unregisterRunSession,
  stallMs,
} from "../integrations/opencode-client";
import type { RunPipelinePort, ObserverPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { buildProduction, type CompositionConfig } from "@contexts/qa-run-orchestration/composition/composition-root";
import { Sha, shaMatches } from "@kernel/sha";
import type { AgentRole } from "@kernel/agent-role";
import type { RunMode, TestTarget } from "@kernel/run-mode";

import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter";
import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs";
import { PromptBudgetAdapter } from "@contexts/generation/infrastructure/prompt-budget.adapter";
import { capDiff, capText } from "@contexts/generation/infrastructure/prompt-cap";
import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy";
import { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy";
import { StrykerMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter";
import { NullValueOracleAdapter } from "@contexts/objective-signal/infrastructure/null-value-oracle.adapter";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter";
import type { GitHubHttpDeps } from "@contexts/workspace-and-publication/infrastructure/github-http";
import { SetupAdapter, nodeFsDeps } from "@contexts/workspace-and-publication/infrastructure/setup.adapter";
import { VcsWriteAdapter } from "@contexts/workspace-and-publication/infrastructure/vcs-write.adapter";
import { CONFINEMENT_DENYLIST, WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service";
import { WriteConfinementAdapter } from "@contexts/workspace-and-publication/infrastructure/write-confinement.adapter";
import { MirrorGcAdapter } from "@contexts/workspace-and-publication/infrastructure/mirror-gc.adapter";
import type { VcsPublishCollaborator } from "@contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage";


import { SandboxedBinaryRunnerAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter";
import { ProcessKillAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter";

import { CodebaseMemoryClient } from "../../qa-engine/src/shared-infrastructure/code-graph/codebase-memory-client";
import { IndexStatusAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/index-status-port.adapter";


import {
  buildPromptAssembled,
  buildWorkerPromptAssembled,
  buildReviewerPromptAssembled,
  buildExplorerPrompt,
  specFileForFlow,
} from "@contexts/generation/infrastructure/prompt-builders/prompts";
import { parseVerdict } from "../integrations/verdict-parse";
import { parseReviewerVerdict, checkGeneratorVerdict, repairInstruction } from "../integrations/verdict-validate";
import { parseExplorationBrief } from "../qa/exploration-brief";
import { roleWindowBytes } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import type { RepairPort } from "@contexts/generation/application/generate-tests.use-case.ts";

import {
  runE2E,
  createDefaultE2eExecuteDeps,
  createDefaultE2eCleanupDeps,
  e2eTimeoutMs,
  type E2eExecuteDeps,
} from "../../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner";

import {
  runCodeTests,
  createDefaultCodeExecuteDeps,
  runCodeCoverage,
  detectCodeProject,
} from "../../qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner";

import {
  validateSpecs,
  defaultValidateDeps,
  validateCodeProject,
  defaultCodeValidateDeps,
} from "../../qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks";
import { scrubEnv } from "../../qa-engine/src/shared-infrastructure/process-sandbox/scrub-env";
import { resolveSandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import { setupCodeProject, createDefaultCodeSetupDeps } from "../../qa-engine/src/contexts/test-execution/infrastructure/code-setup";
import { requireEnv } from "../util/env";
import { RedactionPortAdapter, recordAudit } from "../orchestrator/sanitizer";
import { ensureMirror, ensureMirrorAtBranch, defaultMirrorDeps, workdirRoot, realGit, authHeaderArgs } from "../integrations/repo-mirror";
import { stageServiceContext, serviceContextDir } from "./service-context";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { SqliteLearningRepository, type LearningStore } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter";
import { listLearningRules, listAllLearningRules, upsertLearningRule, incrementRuleUsage, recordRuleOutcome, updateRunOutcomeReflection, listRunOutcomes, setRuleStatusByHuman, markContextStale, saveScorecardEntry, loadCurriculum, saveCurriculum } from "./history";
import { recordIncident } from "./maintainer";
import { preventionOutcome } from "@contexts/cross-run-learning/domain/rule-fold";
import { ReflectorPortAdapter, REFLECT_TIMEOUT_MS } from "@contexts/cross-run-learning/infrastructure/reflector-port.adapter";
import { ProcessAuditPortAdapter } from "@contexts/cross-run-learning/infrastructure/process-audit-port.adapter";
import { CurriculumPortAdapter } from "@contexts/cross-run-learning/infrastructure/curriculum-port.adapter";
import { YamlBoundaryProfileAdapter } from "@contexts/service-topology/infrastructure/yaml-boundary-profile.adapter";
import { expandEnv } from "../orchestrator/config-loader";

/*
 * Role→agent-name mapping for AgentRuntimeAdapter. Also the durable coordination telemetry
 * path — composition writes it and the control plane reads it; they must agree.
 */
export function resolveCoordinationTelemetryPath(): string {
  return (
    process.env.COORDINATION_TELEMETRY_PATH?.trim() ||
    join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "coordination-events.jsonl")
  );
}

export function roleToAgentName(role: AgentRole): string {
  const map: Record<AgentRole, string> = {
    primary: "qa-generator",
    reviewer: "qa-reviewer",
    chat: "qa-assistant",
    worker: "qa-worker",
    workerCode: "qa-worker-code",
    sidekick: "qa-sidekick",
    maintainer: "qa-maintainer",
    reflector: "qa-reflector",
    explorer: "qa-explorer",
    proposer: "qa-proposer",
  };
  return map[role];
}


const E2E_PUBLISH_ADD = ["e2e"];
const E2E_PUBLISH_EXCLUDES = ["node_modules/", "e2e/.qa/coverage/", "e2e/.qa/measured.json", "e2e/.qa/service-context/"];
const CODE_PUBLISH_ADD = ["."];

const CONTEXT_PUBLISH_ADD = ["e2e/.qa/context.json"];

const CODE_PUBLISH_EXCLUDES = [
  "node_modules/",
  ...CONFINEMENT_DENYLIST,
  "dist/",
  "build/",
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "venv/",
  "target/",
  ".next/",
  "coverage/",
  "e2e/.qa/coverage/",
  "e2e/.qa/service-context/",
  ".stryker-tmp/",
  "stryker.conf.json",
  "reports/mutation/",
];

/*
 * Writes gitignore-style patterns to .git/info/exclude (LOCAL, never committed) — same real fs write
 * as publish.ts's own defaultPublishDeps.writeExcludes.
 */
function writeExcludes(mirrorDir: string, patterns: readonly string[]): void {
  const dir = join(mirrorDir, ".git", "info");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "exclude"), patterns.map((p) => `${p}\n`).join(""));
}

type GitFn = (args: string[], cwd?: string) => Promise<string>;

/*
 * realGit is a bare execFile wrapper — auth and commit identity are applied per call site.
 * Fresh mirrors have no git identity, so commit gets -c user.name/email; push gets authHeaderArgs().
 * Env vars are read at call time. qa-engine VcsWriteAdapter stays token-agnostic.
 */
function withPublishGitDecorations(git: GitFn): GitFn {
  return (args, cwd) => {
    if (args[0] === "push") return git([...authHeaderArgs(), ...args], cwd);
    if (args[0] === "commit") {
      const name = process.env.GIT_AUTHOR_NAME ?? "qayaba";
      const email = process.env.GIT_AUTHOR_EMAIL ?? "qayaba@users.noreply.github.com";
      return git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args], cwd);
    }
    return git(args, cwd);
  };
}

/*
 * Test seam: constructs the VcsPublishCollaborator. `git`/`writeExcludesFn` are injectable
 * and always wrapped in withPublishGitDecorations so tests see the same decorated argv as production.
 */
export function buildVcsPublish(
  isCode: boolean,
  
  mode: RunMode,
  git: GitFn = realGit,
  writeExcludesFn: (dir: string, patterns: readonly string[]) => void = writeExcludes,
): VcsPublishCollaborator {
  const vcs = new VcsWriteAdapter(withPublishGitDecorations(git), writeExcludesFn);
  
  const confinementClassifier = new WriteConfinementService();
  const isContext = mode === "context";
  const addDir = isContext ? CONTEXT_PUBLISH_ADD : isCode ? CODE_PUBLISH_ADD : E2E_PUBLISH_ADD;
  /* Context is staged by exact pathspec — exclude patterns have nothing to filter. */
  const excludes = isContext ? [] : isCode ? CODE_PUBLISH_EXCLUDES : E2E_PUBLISH_EXCLUDES;
  
  const denyModifiedTracked = (path: string) => confinementClassifier.isCodeDenied(path);
  return {
    async publish({ mirrorDir, branch }): Promise<{ changed: boolean; revertedDenylisted?: string[]; revertedDangerous?: string[] }> {
      /*
       * Apply local ignore patterns FIRST (same ordering as publish.ts's publishChanges) so both the
       * change check and the `git add` below silently skip installed deps/artifacts instead of
       * failing on an ignored path (the node_modules/.gitignore `git add` failure this ordering fixes).
       */
      await vcs.writeExcludes(mirrorDir, excludes);
      const changed = await vcs.hasChanges(mirrorDir, addDir);
      if (!changed) return { changed: false };
      await vcs.checkoutBranch(mirrorDir, branch);
      const commitMsg = isContext ? "docs(context): automated QA context map" : isCode ? "test(code): automated QA" : "test(e2e): automated QA";
      
      const { revertedDenylisted, revertedDangerous } = await vcs.commit(mirrorDir, commitMsg, addDir, denyModifiedTracked);
      await vcs.push(mirrorDir, branch);
      return { changed: true, revertedDenylisted, revertedDangerous };
    },
  };
}


export function buildConfinement(
  git: GitFn = realGit,
  realpath: (p: string) => string = realpathSync,
  isSymlink: (p: string) => boolean = (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;  /* deleted mid-check or otherwise unreadable — never a symlink escape */
    }
  },
): WriteConfinementAdapter {
  return new WriteConfinementAdapter({ git, realpath, isSymlink });
}


export function buildMirrorGc(git: GitFn = realGit): MirrorGcAdapter {
  return new MirrorGcAdapter((dir) => git(["gc", "--auto", "--quiet"], dir).then(() => {}));
}


export function githubHttpDeps(fetchFn: typeof fetch = fetch): GitHubHttpDeps {
  return {
    fetch: (url, init) => fetchFn(url, init),
    authHeaders: () => ({ Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}` }),
  };
}


export function buildSetupAdapter(): SetupAdapter {
  return new SetupAdapter({
    fs: nodeFsDeps,
    runner: new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() }),
    seedDir: join(process.env.QAYABA_ROOT ?? process.cwd(), "config", "e2e"),
  });
}


async function fetchVersion(url: string): Promise<{ sha?: string; healthy?: boolean } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as { sha?: string; healthy?: boolean };
  } catch {
    return null;
  }
}


export function historyLearningStore(appName: string): LearningStore {
  return {
    selectRules: (app) =>
      listLearningRules(app, 200).map((r) => ({
        id: r.id,
        trigger_text: r.trigger,
        action_text: r.action,
        error_class: r.errorClass,
        archetype: r.archetype ?? null,
        status: r.status,
        confidence: r.confidence,
        usage_count: r.usageCount,
        outcome_count: r.outcomeCount,
        oracle_outcome_count: r.oracleOutcomeCount,
        success_rate: r.successRate,
        last_verified: r.lastVerified,
        source: r.source,
        at: r.at,
      })),
    /* Unfiltered list (all statuses, including deprecated) so distill dedup can see existing rules. */
    selectAllRules: (app, limit) =>
      listAllLearningRules(app, limit).map((r) => ({
        id: r.id,
        trigger_text: r.trigger,
        action_text: r.action,
        error_class: r.errorClass,
        archetype: r.archetype ?? null,
        status: r.status,
        confidence: r.confidence,
        usage_count: r.usageCount,
        outcome_count: r.outcomeCount,
        oracle_outcome_count: r.oracleOutcomeCount,
        success_rate: r.successRate,
        last_verified: r.lastVerified,
        source: r.source,
        at: r.at,
      })),
    upsert: (rule) =>
      upsertLearningRule({
        id: rule.id,
        app: appName,
        trigger: rule.trigger,
        action: rule.action,
        /* history.ts stores ErrorClass; the port types it as string. Taxonomy is the producer. */
        errorClass: rule.errorClass as import("../qa/learning/taxonomy").ErrorClass,
        archetype: rule.archetype ?? null,
        source: rule.source,
      }),
    recordOutcome: (outcome) => {
      
      try {
        const { rulesRetrieved, gateSignals, errorClass } = outcome;
        /* Persist the per-run oracle scorecard even when no rules were retrieved. */
        saveScorecardEntry({
          runId: outcome.runId,
          app: outcome.app,
          sha: outcome.sha,
          target: outcome.target,
          valueScore: gateSignals.valueScore,
          mutantCount: 0,
          killedCount: 0,
          at: outcome.at,
        });
        if (rulesRetrieved.length === 0) return;  /* nothing retrieved -> nothing to fold onto rules */
        const { valueScore, coverageRatio } = gateSignals;
        const coverageMeasured = coverageRatio !== null;
        const coverageCreditConfirmed = coverageMeasured ? coverageRatio > 0 : null;

        if (valueScore !== null) {
          /* Oracle path: isOracleScore=true so candidate→active requires this evidence. */
          for (const id of rulesRetrieved) {
            recordRuleOutcome(id, valueScore, coverageCreditConfirmed, true);
          }
        } else {
          /*
           * Prevention path: no oracle score — derived credit must not advance oracleOutcomeCount
           * or by itself promote candidate → active.
           */
          const rules = listLearningRules(appName, 200);
          const byId = new Map(rules.map((r) => [r.id, r]));
          for (const id of rulesRetrieved) {
            const rule = byId.get(id);
            if (!rule) continue; /* deprecated between retrieval and fold — no signal */
            const score = preventionOutcome(rule.errorClass, errorClass);
            if (score !== null) recordRuleOutcome(id, score, coverageCreditConfirmed);
          }
        }
      } catch {
        /*
         * Off-path swallow, matching LearningPort.fold's existing off-path contract: a fold failure
         * must never gate or fail the run it is trying to learn from.
         */
      }
    },
    
    incrementUsage: (ids) => incrementRuleUsage([...ids]),
  };
}

/* The host's already-built real collaborators this factory reuses instead of re-assembling. */
export interface RewrittenEngineFactoryDeps {
  /*
   * Reads the SAME AgentDeps facade the host's currentAgentDeps() resolves (src/index.ts) — the
   * real :4097 supervisor, not a second AgentRuntimeManager instance.
   */
  getAgentDeps: () => AgentDeps;
  
  historyFilePath?: string;
  env?: Record<string, string | undefined>;
  mirrorRoot?: string;
  /* Test seam: inject spies for the two mirror primitives instead of real git/disk. */
  mirror?: {
    ensureMirror: typeof ensureMirror;
    ensureMirrorAtBranch: typeof ensureMirrorAtBranch;
  };
  /* Test seam: inject a spy/no-op for service-context staging instead of real disk/git. */
  stageServiceContext?: typeof stageServiceContext;
}


export function buildRewrittenCompositionConfig(
  app: AppConfig,
  deps: RewrittenEngineFactoryDeps,
  namespace: string,
  run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string },
  
  observer?: ObserverPort,
): CompositionConfig {
  const target: TestTarget = run.target ?? (app.code === true ? "code" : "e2e");
  const isCode = target === "code";
  /*
   * An e2e-target run without a live DEV URL cannot be composed — fail loud here, before any
   * git clone/agent session/Playwright spawn.
   */
  if (!isCode && !app.dev?.baseUrl) {
    throw new Error(
      `App "${app.name}" has target "e2e" but no dev.baseUrl configured — set dev.baseUrl in config/apps/${app.name}.yaml or run with --target code.`,
    );
  }
  const e2eRelDir = "e2e";
  
  const redactionPort = new RedactionPortAdapter();
  
  const e2eDefaultTimeoutMs = e2eTimeoutMs(process.env);
  const pwActionTimeoutMs = process.env.PW_ACTION_TIMEOUT_MS;
  
  const codeSandbox = resolveSandbox(process.env);
  
  const coveragePolicy = { mode: app.qa.changeCoverage?.mode ?? "signal", minRatio: app.qa.changeCoverage?.minRatio ?? 0.7 } as const;
  
  const mirrorRoot = deps.mirrorRoot ?? workdirRoot();
  /*
   * Placeholder static mirrorDir — the real per-run dir is whatever checkout(sha) returns.
   * This field satisfies CompositionConfig's static shape and seeds the coverage collector.
   * An unmeasured/mismatched repoDir reads as "unknown", which never blocks publish.
   */
  const mirrorDir = join(mirrorRoot, app.repo.replaceAll("/", "__"));
  const e2eDir = join(mirrorDir, e2eRelDir);

  
  const triggerService =
    run.triggerRepo && run.triggerRepo !== app.repo
      ? app.services?.find((s) => s.repo === run.triggerRepo)
      : undefined;
  if (run.triggerRepo && run.triggerRepo !== app.repo && !triggerService) {
    throw new Error(`trigger repo ${run.triggerRepo} is not a declared service of app ${app.name}`);
  }
  
  if (triggerService && run.mode === "context") {
    throw new Error(`context mode cannot be triggered by a service repo (${triggerService.repo}); run it from the primary repo ${app.repo}`);
  }
  /*
   * deps.mirror is a test seam only. Production checkout always uses defaultMirrorDeps
   * (workdirRoot()). deps.mirrorRoot overrides the path, not the git collaborator.
   */
  const mirror = deps.mirror ?? { ensureMirror, ensureMirrorAtBranch };
  /* Defaults to the real stageServiceContext in production. */
  const stage = deps.stageServiceContext ?? stageServiceContext;

  
  const branch = namespace;

  const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });
  /*
   * Cross-repo composition (bug fix): the diff/classify SOURCE is the SERVICE mirror at the event
   * sha for a cross-repo run — never the primary. Same dir formula as mirrorDir above
   * (mirrorRoot + repo.replaceAll("/", "__")), reused verbatim so this can never silently diverge
   * from where ensureMirror actually writes (the SAME rationale mirrorDir's own comment gives).
   */
  const vcsDir = triggerService ? join(mirrorRoot, triggerService.repo.replaceAll("/", "__")) : mirrorDir;
  const vcs = new GitMirrorReadAdapter(vcsDir, runner);

  
  const structuralSignalsMode = app.qa.structuralSignals?.mode ?? "signal";
  const structuralSignalsOn = structuralSignalsMode !== "off";

  /* Reuse the host AgentDeps. Forward descriptor so session registration sees the real runId. */
  const runtimeAdapter = new AgentRuntimeAdapter(
    {
      open: async (agent, cwd, opts) => {
        const real = deps.getAgentDeps();
        return real.open(agent, cwd, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
        });
      },
    },
    roleToAgentName,
  );
  const rendering = new PromptRenderingAdapter({ buildPromptAssembled, buildWorkerPromptAssembled, buildReviewerPromptAssembled, buildExplorerPrompt, specFileForFlow });
  const verdicts = new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });

  /* Bounded contract-repair for malformed generator/reviewer verdicts — fail-closed if still invalid. */
  const repair: RepairPort = {
    checkGenerator: (text) => checkGeneratorVerdict(text),
    instruction: (kind, issues, opts) => repairInstruction(kind, issues, opts),
  };

  const generationUseCase = new GenerateTestsUseCase({
    runtime: runtimeAdapter,
    rendering,
    verdicts,
    manifest: new ManifestRepositoryAdapter({ readManifest, reconcileManifest }),
    budget: new PromptBudgetAdapter(roleWindowBytes, capDiff, capText),
    repair,
  });

  
  const staticGate = new StaticGateAdapter({
    typecheck: defaultValidateDeps.typecheck,
    lint: defaultValidateDeps.lint,
    listTests: defaultValidateDeps.listTests,
    checkManifest: defaultValidateDeps.checkManifest,
    validateAll: (specDir) => validateSpecs(specDir, defaultValidateDeps),
  });
  /* Code-target Filter B: compile-feedback before execution. */
  const codeValidate = new CodeValidationStrategy((repoDir, opts) => validateCodeProject(repoDir, defaultCodeValidateDeps, opts));

  
  const e2eExecuteDeps: E2eExecuteDeps = { ...createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eDefaultTimeoutMs, pwActionTimeoutMs), recordAudit };
  const e2eCleanupDeps = createDefaultE2eCleanupDeps(new ProcessKillAdapter());
  const e2e = new E2eExecutionStrategy((specDir, opts) => runE2E(specDir, opts, e2eExecuteDeps));
  
  const codeExecuteDeps = { ...createDefaultCodeExecuteDeps(codeSandbox), recordAudit };
  const codeSetupDeps = createDefaultCodeSetupDeps(codeSandbox);
  const code = new CodeExecutionStrategy((repoDir, opts) => runCodeTests(repoDir, opts, codeExecuteDeps));

  /*
   * changedFiles starts as [] — no per-run diff exists at composition time. measure() derives the
   * real list from the dynamic diff. repoDir/e2eDir stay primary-bound: browser coverage cannot map
   * service-repo lines, so cross-repo coverage is "unknown" (never blocks publish).
   */
  const rawCollector = makeTargetCoverageCollector({ target, repoDir: mirrorDir, e2eDir, changedFiles: [] });
  
  const collector: typeof rawCollector = isCode
    ? {
        collect: async (specDir, namespace, changedFiles) => {
          await runCodeCoverage(mirrorDir, codeSandbox).catch(() => {});
          return rawCollector.collect(specDir, namespace, changedFiles);
        },
      }
    : rawCollector;
  
  const runCorruptedFaultInjection = ({ dir, baseUrl, namespace }: { dir: string; baseUrl: string; namespace: string }) =>
    /*
     * Desktop-only on purpose: the oracle measures assertion strength, not viewport behavior, and
     * the seed runs every spec in BOTH projects — one project halves the re-run cost. A repo whose
     * config renamed the seed's "desktop" project fails the pass → infra-error → valueScore null
     * (inconclusive), never a wrong score.
     */
    runE2E(dir, { baseUrl, namespace, faultInject: true, project: "desktop" }, e2eExecuteDeps);
  const countInjectedFaultInjectionResponses = (e2eDir: string, namespace: string): number => {
    try {
      const dir = join(e2eDir, ".qa", "fault-injection", namespace);
      let total = 0;
      for (const f of readdirSync(dir)) {
        try {
          total += Number((JSON.parse(readFileSync(join(dir, f), "utf8")) as { corrupted?: unknown }).corrupted) || 0;
        } catch {
          /* unreadable dump — skip */
        }
      }
      return total;
    } catch {
      return 0;  /* no marker dir — nothing was corrupted */
    }
  };

  
  const mutationOracleDeps = { spawn, detectCodeProject, scrubEnv, processKill: new ProcessKillAdapter() };

  /*
   * P0-2: honor YAML qa.valueOracle (and the shadow-aware default the CLI already reports).
   * "off" → NullValueOracleAdapter (no DEV re-run, no Stryker). "signal" → the target-specific
   * oracle (Stryker for code, fault-injection for e2e).
   */
  const valueOraclePolicy = resolveValueOraclePolicy(app.qa);
  const oracle = valueOraclePolicy === "off"
    ? new NullValueOracleAdapter()
    : isCode
      ? new StrykerMutationOracleAdapter(mutationOracleDeps)
      : new FaultInjectionOracleAdapter(runCorruptedFaultInjection, countInjectedFaultInjectionResponses, app.dev?.baseUrl ?? "");

  /*
   * checkout(sha) resolves the real per-run mirrorDir. Same-repo: ensureMirror at the event SHA.
   * Cross-repo: service mirror to the event sha first (diff/classify source), then primary to
   * baseBranch HEAD (suite operate-on dir). The agent session is rooted at the primary copy, so
   * after each service mirror is ensured, stage READ-ONLY context into the primary at the same
   * deterministic path composition already computed. Clone every declared service every run;
   * the triggering service stays at the event SHA (not also at branch HEAD). Sibling staging is
   * contracts-only (no sha).
   */
  const stageDeclaredServices = async (primaryDir: string, skipRepo?: string): Promise<void> => {
    if (!app.services?.length) return;
    for (const svc of app.services) {
      if (skipRepo && svc.repo === skipRepo) continue;
      const svcDir = await mirror.ensureMirrorAtBranch(svc.repo, svc.baseBranch ?? "main", defaultMirrorDeps);
      await stage({
        workingCopyDir: primaryDir,
        service: { repo: svc.repo, mirrorDir: svcDir, ...(svc.openapi ? { openapi: svc.openapi } : {}) },
      });
    }
  };

  const checkout = async (checkoutSha: Sha): Promise<string> => {
    if (triggerService) {
      await mirror.ensureMirror(triggerService.repo, checkoutSha.value, defaultMirrorDeps);
      const primaryDir = await mirror.ensureMirrorAtBranch(app.repo, app.baseBranch ?? "main", defaultMirrorDeps);
      await stage({
        workingCopyDir: primaryDir,
        service: { repo: triggerService.repo, mirrorDir: vcsDir, ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) },
        sha: checkoutSha.value,
      });
      await stageDeclaredServices(primaryDir, triggerService.repo);
      return primaryDir;
    }
    const primaryDir = await mirror.ensureMirror(app.repo, checkoutSha.value, defaultMirrorDeps);
    await stageDeclaredServices(primaryDir);
    return primaryDir;
  };

  
  const learningRepo = new SqliteLearningRepository(historyLearningStore(app.name));

  
  const setupAdapter = buildSetupAdapter();
  const shouldExplore = app.qa.explorer || (app.services?.length ?? 0) > 0;

  return {
    repo: app.repo,
    appName: app.name,
    mirrorDir,
    e2eRelDir,
    branch,
    target,
    
    mode: run.mode,
    ...(run.guidance ? { guidance: run.guidance } : {}),
    needsReview: app.qa.needsReview,
    shadow: app.qa.shadow ?? false,
    onFailure: app.report.onFailure,
    maxRetries: app.qa.fixLoop?.maxRetries ?? 2,
    isCode,
    /*
     * Multi-agent coordination is always wired. Fail-open paths inside RunQaUseCase are the
     * incident safety net; telemetry lands in the durable JSONL sink. Distinct from qa.shadow
     * (PR/Issue publishing). Default path matches HISTORY_DB_PATH's data/ root;
     * COORDINATION_TELEMETRY_PATH overrides (e.g. a mounted volume).
     */
    coordinationTelemetryPath: resolveCoordinationTelemetryPath(),
    /*
     * Escalated sidekick model — infra only; threaded as OpenSessionOpts.model when capability is
     * sidekick-escalated. Absent → same worker model as sidekick-standard.
     */
    ...(process.env.COORDINATION_ESCALATED_MODEL?.trim()
      ? { sidekickEscalatedModel: process.env.COORDINATION_ESCALATED_MODEL.trim() }
      : {}),
    /*
     * Derived from coveragePolicy.mode (computed once, above) — single source, see this fn's own
     * header comment near `const coveragePolicy = ...`.
     */
    coveragePolicyMode: coveragePolicy.mode,
    agentTimeoutMs: agentTimeout(run.mode),
    ...(app.qa.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: app.qa.wallClockBudgetMs } : {}),
    ...(app.qa.iterationBudget !== undefined ? { iterationBudget: app.qa.iterationBudget } : {}),
    
    diff: "",

    vcs,
    generationUseCase,
    readSpecSource: (absolutePath: string) => readFile(absolutePath, "utf8"),
    reviewRuntime: {
      runtime: runtimeAdapter,
      rendering,
      verdicts,
    },
    reviewTimeoutMs: REVIEWER_TIMEOUT_MS,
    validationStrategies: { e2e: staticGate, code: codeValidate },
    executionStrategies: { e2e, code },
    
    setupCollaborators: {
      e2e: (specDir, opts) => setupAdapter.setup(specDir, opts),
      code: (specDir, opts) => setupCodeProject(specDir, codeSetupDeps, opts),
    },
    
    cleanupCollaborators: {
      e2e: (args) => e2eCleanupDeps.runCleanup(args),
    },
    
    groundingCollaborators: shouldExplore && !isCode
      ? {
          exploreBrief: async ({ specDir, diff, signal, sha, intent }) => {
            const cwd = dirname(specDir);
            let session: Awaited<ReturnType<typeof runtimeAdapter.openSession>> | undefined;
            try {
              session = await runtimeAdapter.openSession("explorer", cwd, {
                ...(signal ? { signal } : {}),
                timeoutMs: EXPLORER_TIMEOUT_MS,
                descriptor: { role: "qa-explorer" },
              });
              const prompt = buildExplorerPrompt({
                repo: app.repo,
                sha: sha ?? namespace,
                diff: diff ?? "",
                mirrorDir: cwd,
                e2eRelDir,
                namespace,
                needsReview: app.qa.needsReview,
                target,
                mode: run.mode,
                appName: app.name,
                explorer: true,
                ...(app.dev?.baseUrl ? { baseUrl: app.dev.baseUrl } : {}),
                ...(run.guidance ? { guidance: run.guidance } : {}),
                ...(intent ? { intent } : {}),
                ...(triggerService
                  ? { service: { repo: triggerService.repo, mirrorDir: serviceContextDir(cwd, triggerService.repo), ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) } }
                  : {}),
              });
              const { output } = await session.prompt(prompt, { textOnly: true });
              return parseExplorationBrief(output) ?? undefined;
            } catch (err) {
              console.warn(`[qa] WARNING: explorer pass failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
              return undefined;
            } finally {
              await session?.dispose();
            }
          },
        }
      : {},
    reviewDomGroundingCollaborators: {},
    /*
     * Per-run lastIndexedSha sidecar (cheap JSON under QAYABA_ROOT/data). Always supplied —
     * the use-case phase is a no-op unless wireBridges also builds codeGraph from codebaseMemory
     * (gated by structuralSignalsOn). First-time full index of an unresolved project is now
     * LazyProjectCodeGraphAdapter.syncTo (index_repository with repo_path only).
     */
    indexStatus: new IndexStatusAdapter(join(process.env.QAYABA_ROOT ?? process.cwd(), "data")),
    /*
     * Classify-source repo root: SERVICE mirror on a webhook, PRIMARY otherwise. Indexing and
     * the structural-signal adapter must pin this dir — workspace.mirrorDir is the suite (primary)
     * even on a cross-repo run, so using it would stamp the service SHA onto the frontend graph.
     */
    codeGraphRepoDir: vcsDir,
    
    ...(structuralSignalsOn ? { codebaseMemory: new CodebaseMemoryClient(runner) } : {}),
    
    ...(structuralSignalsOn && app.services?.length && app.boundaries?.length
      ? {
          serviceTopology: {
            appName: app.name,
            primaryRepo: app.repo,
            mirrorRoot,  /* the SAME local already computed above (deps.mirrorRoot ?? workdirRoot()) */
            services: app.services.map((s) => ({ repo: s.repo })),
            boundaryProfiles: new YamlBoundaryProfileAdapter((name) =>
              expandEnv(readFileSync(join(process.env.QAYABA_ROOT ?? process.cwd(), "config", "apps", `${name}.yaml`), "utf8"))),
          },
        }
      : {}),
    
    ...(structuralSignalsOn && app.services?.length && app.boundaries?.length
      ? { crossRepoImpact: { mirrorRoot, codebaseMemory: new CodebaseMemoryClient(runner), runner } }
      : {}),
    
    ...(app.dev?.baseUrl ? { baseUrl: app.dev.baseUrl } : {}),
    ...(app.openapi ? { openapi: app.openapi } : {}),
    
    ...(triggerService
      ? { triggerService: { repo: triggerService.repo, mirrorDir: serviceContextDir(mirrorDir, triggerService.repo), ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) } }
      : {}),
    
    ...(run.mode === "context" && app.services?.length
      ? {
          services: app.services.map((svc) => ({
            repo: svc.repo,
            mirrorDir: serviceContextDir(mirrorDir, svc.repo),
            ...(svc.openapi ? { openapi: svc.openapi } : {}),
          })),
        }
      : {}),
    
    ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}),
    objectiveSignal: { collector, oracle },
    coveragePolicy,
    /* Change-coverage: unknown never blocks publish. */
    assembleChangeCoverage,
    baselineCases: [],

    
    githubPr: new GitHubPrAdapter(githubHttpDeps(), app.baseBranch ?? "main"),
    githubIssue: new GitHubIssueAdapter(githubHttpDeps()),
    /* Stage/commit/push generated tests before opening the PR. e2e → e2e/; code → whole tree minus deps. */
    vcsWrite: buildVcsPublish(isCode, run.mode),
    
    confinement: buildConfinement(),
    
    mirrorGc: buildMirrorGc(),
    reviewerApprovedForPublish: true,
    coverageBlocksForPublish: false,
    e2eChangedForPublish: true,
    
    sanitize: (text: string) => redactionPort.redact(text),
    
    containsSecret: (text: string) => redactionPort.containsSecret(text),

    checkout,
    /*
     * Cross-repo: gate on the SERVICE versionUrl, never the primary's. No versionUrl → skip the gate.
     */
    versionUrl: triggerService ? triggerService.versionUrl : app.dev?.versionUrl,
    /*
     * Single-shot probe (see fetchVersion's own header) — DeployGatePortAdapter.waitUntilServing
     * is the ONLY poll loop; this fn is called once per its interval, never loops itself.
     */
    versionPoll: (triggerService ? triggerService.versionUrl : app.dev?.versionUrl)
      ? async (versionUrl: string, sha) => {
          const v = await fetchVersion(versionUrl);
          return { serving: shaMatches(v?.sha, sha.value) && v?.healthy === true };
        }
      : undefined,
    /* Service poll defaults (10s/10min) differ from the primary's (2s/60s). */
    deployGateIntervalMs: triggerService
      ? (triggerService.pollIntervalMs ?? 10_000)
      : (app.dev?.pollIntervalMs ?? 2000),
    deployGateTimeoutMs: triggerService
      ? (triggerService.deployTimeoutMs ?? 600_000)
      : (app.dev?.deployTimeoutMs ?? 60000),

    
    ...(deps.historyFilePath ? { historyFilePath: deps.historyFilePath } : { runHistory: new SqliteRunHistoryAdapter() }),
    
    learningRepo,
    /*
     * This factory is the one module that may import both qa-engine @contexts aliases and root
     * src/, so it is the only place that can construct ReflectorPortAdapter: same runtimeAdapter
     * as review, same learningRepo, and host-side backfill via updateRunOutcomeReflection.
     * REFLECTOR_TIMEOUT_MS parsed here with Number(process.env.X) || default; unset falls back
     * to the adapter's REFLECT_TIMEOUT_MS (60_000).
     */
    reflectorPort: new ReflectorPortAdapter({
      runtime: runtimeAdapter,
      repo: learningRepo,
      
      backfill: (runId, refl) => updateRunOutcomeReflection(runId, refl as import("../types").StructuredReflection),
      cwd: mirrorDir,
      app: app.name,
      timeoutMs: Number((deps.env ?? process.env).REFLECTOR_TIMEOUT_MS) || REFLECT_TIMEOUT_MS,
    }),
    
    processAudit: new ProcessAuditPortAdapter({
      app: app.name,
      readRecentOutcomes: (a, limit) => listRunOutcomes(a, limit),
      readRules: (a, limit) => listLearningRules(a, limit),
      deprecateRule: (ruleId) => { setRuleStatusByHuman(ruleId, "deprecated"); },
      recordEngineIncident: (finding) =>
        recordIncident({
          source: "process-audit",
          severity: finding.severity === "error" ? "error" : "warn",
          summary: finding.summary,
          /*
           * finding.diagnosis is never populated by this port today (Layer 2 LLM root-cause
           * diagnosis is deferred — see process-audit.ts's own SCOPE NOTE); kept conditional so a
           * future diagnosis producer needs no change here.
           */
          detail: [finding.evidence, finding.diagnosis ? `\nLIKELY ROOT CAUSE: ${finding.diagnosis}` : ""].join(""),
        }),
      invalidateContext: (reason) => {
        try {
          markContextStale(app.name);
          console.log(`[audit] marked context stale for ${app.name} — rebuilds next run (${reason})`);
          return true;
        } catch {
          return false; 
        }
      },
    }),
    /*
     * CurriculumPort — per-app scenario-archetype prior. Constructed here because its store is
     * history.ts (src-only; qa-engine may never import it). Wired unconditionally: measure-and-rank
     * only, never gates a verdict, publish, or coverage decision.
     */
    curriculumPort: new CurriculumPortAdapter(app.name, loadCurriculum, saveCurriculum),
    ...(observer ? { observer } : {}),
  };
}


export function createRewrittenEngineFactory(
  deps: RewrittenEngineFactoryDeps,
): (appConfig: AppConfig, namespace: string, run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string }, observer?: ObserverPort, previousNamespace?: string) => RunPipelinePort {
  const env = deps.env ?? process.env;
  const wrappedDeps: RewrittenEngineFactoryDeps = {
    ...deps,
    getAgentDeps: () =>
      withUsageSink(
        withStallWatchdog(
          withSessionRegistration(deps.getAgentDeps(), { register: registerRunSession, unregister: unregisterRunSession }),
          { stallMs: stallMs() },
        ),
      ),
  };
  return (appConfig: AppConfig, namespace: string, run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string }, observer?: ObserverPort): RunPipelinePort => {
    const cfg = buildRewrittenCompositionConfig(appConfig, wrappedDeps, namespace, run, observer);
    return buildProduction(env, cfg);
  };
}
