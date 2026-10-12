/*
 * Composition root: maps AppConfig into a qa-engine CompositionConfig and returns
 * buildProduction(...). Wires host collaborators (agent runtime, GitHub, runners).
 * Env reads for execution timeouts stay here. Agent remains read-only on watched repos.
 */

import { join } from "node:path";
import { qayabaDataDir, qayabaRoot } from "../paths";
import { readFileSync, mkdirSync, writeFileSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { AppConfig } from "../orchestrator/config-loader";
import { resolveValueOraclePolicy } from "../orchestrator/schemas";
import type { AgentDeps } from "../integrations/opencode-client";
import { REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, agentPromptCapMs, agentTimeout, withTimeout } from "../integrations/opencode-client";
import { AGENT_NAME_FOR_ROLE, assignmentForRole, type AgentFacade, type StepLimits } from "../agent-runtime/types";
import { enforcedStepLimit } from "../agent-runtime/step-limit";

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
import { AuthSessionAdapter } from "@contexts/qa-run-orchestration/infrastructure/auth-session.adapter";
import { createDiscoverLogin } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.runner";
import { createCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot";
import { defaultContextPackDeps } from "@contexts/generation/infrastructure/context-pack";
import { loadContextMapFromDisk } from "@contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter";
import { ContextMapCapturePortAdapter, type ContextMapSave, type ContextMapWrittenThisRun } from "@contexts/qa-run-orchestration/infrastructure/bridges/context-map-capture-port.adapter";
import { Sha, shaMatches } from "@kernel/sha";
import { DEFAULT_CLOSED_LOOP_LIMITS } from "@kernel/closed-loop";
import { AccountLock } from "@contexts/test-execution/domain/account-lock";
import { ClosedLoopRegistry } from "@contexts/qa-run-orchestration/infrastructure/closed-loop-registry";
import { redactByValue } from "../../qa-engine/src/shared-infrastructure/run-secret-redaction";
import { ValidationPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/validation-port.adapter";
import { ExecutionPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter";
import { ObjectiveSignalPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter";
import { ReviewPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/review-port.adapter";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service";
import type { ExecutionPort, ObjectiveSignalPort, ReviewPort, ValidationPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { AgentRole } from "@kernel/agent-role";
import type { RunMode, TestTarget } from "@kernel/run-mode";

import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case";
import { resolveDiffTimeBudgets } from "@contexts/generation/domain/generator-time-budget";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter";
import { RunDeadline } from "@contexts/qa-run-orchestration/domain/run-deadline";
import { resolveRunTimeBudgets } from "@contexts/qa-run-orchestration/domain/run-time-budget";
import { RunDeadlineRuntime } from "@contexts/qa-run-orchestration/infrastructure/run-deadline-runtime.adapter";
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
import { countInjectedResponses } from "@contexts/objective-signal/infrastructure/fault-injection-counter-reader";
import { NullValueOracleAdapter } from "@contexts/objective-signal/infrastructure/null-value-oracle.adapter";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter";
import type { GitHubHttpDeps } from "@contexts/workspace-and-publication/infrastructure/github-http";
import { SetupAdapter, nodeFsDeps } from "@contexts/workspace-and-publication/infrastructure/setup.adapter";
import { VcsWriteAdapter } from "@contexts/workspace-and-publication/infrastructure/vcs-write.adapter";
import { CONFINEMENT_DENYLIST, WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service";
import { WriteConfinementAdapter } from "@contexts/workspace-and-publication/infrastructure/write-confinement.adapter";
import { MirrorGcAdapter } from "@contexts/workspace-and-publication/infrastructure/mirror-gc.adapter";
import { SuiteStoreAdapter, gitListTracked } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter";
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
import { ExplorerBriefSessionAdapter } from "@contexts/generation/infrastructure/explorer-brief-session.adapter";
import type { StepLimitFor, StepLimitRole } from "@contexts/generation/application/ports/generation-ports";
import { MultiRepoCheckoutAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/multi-repo-checkout.adapter";
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
  createValidateDeps,
  validateCodeProject,
  createCodeValidateDeps,
} from "../../qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks";
import { resolveSandbox, openInstallTree, sealInstallTree, type Sandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import type { ExecSandboxPort } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { createExecBinaryRunner } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-binary-runner";
import { buildExecWiring, suiteAccountFor } from "./exec-sandbox-factory";
import { egressGateFor, loadRegistryGroups, resolveRunOrigins } from "./egress-wiring";
import { setSandboxGroup } from "../../qa-engine/src/shared-infrastructure/process-sandbox/git-hardening";
import { setupCodeProject, createDefaultCodeSetupDeps } from "../../qa-engine/src/contexts/test-execution/infrastructure/code-setup";
import { requireEnv } from "../util/env";
import { RedactionPortAdapter, recordAudit } from "../orchestrator/sanitizer";
import { ensureMirror, ensureMirrorAtBranch, defaultMirrorDeps, workdirRoot, realGit, authHeaderArgs, hardenGitArgs, assertTrustedGitTree } from "../integrations/repo-mirror";
import { stageServiceContext, serviceContextDir } from "./service-context";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { SqliteLearningRepository, type LearningStore } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter";
import { listLearningRules, listLearningRulesForGovernance, getLearningRule, listAllLearningRules, quarantineLearningRules, upsertLearningRule, incrementRuleUsage, recordRuleOutcome, updateRunOutcomeReflection, listRunOutcomes, setRuleStatusByHuman, markContextStale, isContextStale, clearContextStale, saveScorecardEntry, loadCurriculum, saveCurriculum, saveContextMap, loadContextMap as loadStoredContextMap } from "./history";
import { recordIncident } from "./maintainer";
import { resolveCampaignFreeze } from "./campaign-freeze";
import { resolveReflectorEnabled } from "./reflector-switch";
import { attributableRules, preventionOutcome } from "@contexts/cross-run-learning/domain/rule-fold";
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
    join(qayabaDataDir(), "coordination-events.jsonl")
  );
}

/*
 * Per-delegation wall-clock cap (ms), env-tunable. qa-engine's composition-root never reads
 * process.env itself (CLAUDE.md invariant) — this shell resolves the env var ONCE and threads the
 * result into CompositionConfig.sidekickTimeoutMs; composition-root falls back to its own hardcoded
 * default (420_000) when this returns undefined (env absent/invalid).
 */
export function resolveSidekickTimeoutMsFromEnv(): number | undefined {
  const raw = Number(process.env.COORDINATION_SIDEKICK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function roleToAgentName(role: AgentRole): string {
  return AGENT_NAME_FOR_ROLE[role];
}


const E2E_PUBLISH_ADD = ["e2e"];
const E2E_PUBLISH_EXCLUDES = ["node_modules/", "e2e/.qa/coverage/", "e2e/.qa/measured.json", "e2e/.qa/service-context/", "e2e/.qa/*.tmp", "e2e/.auth/"];
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
 * as publish.ts's own defaultPublishDeps.writeExcludes. The sandbox owns the mirror's directory, so the git dir
 * is verified as the orchestrator's own first: a `.git` swapped for a link must never be written through.
 */
function writeExcludes(mirrorDir: string, patterns: readonly string[]): void {
  assertTrustedGitTree(mirrorDir);
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
  /* rmSync deletes a link inside the tree, never what it points to. */
  return new WriteConfinementAdapter({ git, realpath, isSymlink, removeDirectory: (path) => rmSync(path, { recursive: true, force: true }) });
}


export function buildMirrorGc(git: GitFn = realGit): MirrorGcAdapter {
  return new MirrorGcAdapter((dir) => git(["gc", "--auto", "--quiet"], dir).then(() => {}));
}


/*
 * The ONLY place GITHUB_TOKEN is read for the publish path: qa-engine's github-http.ts takes
 * authHeaders() as an injected closure and never reads process.env itself (qa-engine never
 * reads process.env at all), so this composition root is the sole credential-locality seam for
 * every GitHub PR/Issue call the engine makes. (repo-mirror.ts and src/integrations/
 * github.ts read GITHUB_TOKEN too, but for git clone/fetch auth and the login/collaborator-check
 * path respectively — different concerns, not the publish path this closure serves.)
 */
export function githubHttpDeps(fetchFn: typeof fetch = fetch): GitHubHttpDeps {
  return {
    fetch: (url, init) => fetchFn(url, init),
    authHeaders: () => ({ Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}` }),
  };
}


/*
 * The e2e project's `npm ci` runs the project's own lifecycle scripts, which the agent can edit: it runs as the sandbox
 * uid through the launcher's `install` profile, and the tree it writes is handed over before and sealed after.
 */
export function buildSetupAdapter(exec: ExecSandboxPort, sandbox: Sandbox | null): SetupAdapter {
  return new SetupAdapter({
    fs: nodeFsDeps,
    runner: createExecBinaryRunner({ exec, profile: "install", processKill: new ProcessKillAdapter() }),
    seedDir: join(qayabaRoot(), "config", "e2e"),
    installGuard: { open: (dir) => openInstallTree(dir, sandbox), seal: (dir) => sealInstallTree(dir, sandbox) },
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
    /*
     * Dedicated governance-path read, NOT listLearningRules(app, LEARNING_RULE_LEDGER_LIMIT) —
     * that shared-limit, actives-first-ranked query could exhaust its LIMIT on active rows alone,
     * never even fetching a fresh candidate into memory for RuleGovernanceService.topRules (the
     * single ranking truth) to rank. See listLearningRulesForGovernance's own header in history.ts.
     */
    selectRules: (app) =>
      listLearningRulesForGovernance(app).map((r) => ({
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
        quarantined_at: r.quarantinedAt ?? null,
      })),
    quarantine: (app, ids, at) => quarantineLearningRules(app, ids, at),
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
          /* Real counts when the value-oracle measured this run; null ("not measured") otherwise —
           * never a hardcoded 0, which would be indistinguishable from a genuine measured zero. */
          mutantCount: gateSignals.mutantCount ?? null,
          killedCount: gateSignals.killedCount ?? null,
          at: outcome.at,
        });
        if (rulesRetrieved.length === 0) return;  /* nothing retrieved -> nothing to fold onto rules */
        const { valueScore, coverageRatio } = gateSignals;
        const coverageMeasured = coverageRatio !== null;
        const coverageCreditConfirmed = coverageMeasured ? coverageRatio > 0 : null;
        /*
         * Attribution: credit only the retrieved rules that could have shaped this run — untagged
         * rules, or rules tagged with one of the diff's structural shapes. A suite-level score says
         * nothing about a rule written for an unrelated kind of change. No known shapes (non-diff
         * modes) keeps every rule. Rules are looked up directly by id within this app
         * (getLearningRule), never via a capped bulk list, so ledger size cannot drop a fold; a rule
         * deleted since retrieval, or another app's id, carries no signal. A rule retired after retrieval (human veto, process audit) is skipped
         * by recordRuleOutcome itself.
         */
        const retrieved = rulesRetrieved
          .map((id) => getLearningRule(appName, id))
          .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);
        const attributable = attributableRules(retrieved, { diffArchetypes: outcome.diffArchetypes ?? [] });

        if (valueScore !== null) {
          /* Oracle path: isOracleScore=true so candidate→active requires this evidence. */
          for (const rule of attributable) {
            recordRuleOutcome(rule.id, valueScore, coverageCreditConfirmed, true);
          }
        } else {
          /*
           * Prevention path: no oracle score — derived credit must not advance oracleOutcomeCount
           * or by itself promote candidate → active.
           */
          for (const rule of attributable) {
            const score = preventionOutcome(rule.errorClass, errorClass);
            if (score !== null) recordRuleOutcome(rule.id, score, coverageCreditConfirmed);
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

/* Two uses of one test account never interleave, whichever run they belong to. */
const PROCESS_ACCOUNT_LOCK = new AccountLock();

/* The host's already-built real collaborators this factory reuses instead of re-assembling. */
export interface RewrittenEngineFactoryDeps {
  /*
   * Reads the SAME AgentDeps facade the host's currentAgentDeps() resolves (src/index.ts) — the
   * real :4097 supervisor, not a second AgentRuntimeManager instance.
   */
  getAgentDeps: () => AgentDeps;
  /*
   * The agent runtime's CURRENT facade, resolved once per run: the runtime is switchable, so a facade held any
   * longer could be the wrong runtime's. It is where the step limit each role runs under is read from. Optional:
   * absent, no prompt of the run states a step limit.
   */
  getAgentFacade?: () => AgentFacade;

  historyFilePath?: string;
  env?: Record<string, string | undefined>;
  /* Test seam: the clock the run-level deadline counts down on. Absent: the system clock. */
  now?: () => number;
  /*
   * Where the generator's sessions find the run's run_spec loop. One per process, shared with the tools endpoint that serves the
   * tool's calls. Absent: no run is ever granted the tool.
   */
  closedLoopRegistry?: ClosedLoopRegistry;
  mirrorRoot?: string;
  /* Test seam: inject spies for the two mirror primitives instead of real git/disk. */
  mirror?: {
    ensureMirror: typeof ensureMirror;
    ensureMirrorAtBranch: typeof ensureMirrorAtBranch;
  };
  /* Test seam: inject a spy/no-op for service-context staging instead of real disk/git. */
  stageServiceContext?: typeof stageServiceContext;
  /*
   * The process-audit context-heal's REBUILD side: enqueue a `mode: context` run of `app` at `sha`
   * and return its run id, or "" when the queue refuses new work. Called when a run sees the
   * context_stale flag (see requestContextHeal below). A failure to enqueue never blocks or fails
   * the run that triggered it.
   */
  enqueueContextRun?: (input: ContextHealRunRequest) => string | Promise<string>;
}

export interface ContextHealRunRequest {
  app: string;
  /* The triggering run's own sha: the one DEV serves for a gated app that got this far. */
  sha: string;
}

/* Persist a context run's validated map; a fresh map replaces the one the stale flag condemned. */
const storeFreshContextMap: ContextMapSave = (app, sha, map) => {
  saveContextMap(app, sha, map);
  clearContextStale(app);
};

/* The mirror's git status for the spec dir's context map: any entry means this run wrote it. */
const contextMapWrittenThisRun: ContextMapWrittenThisRun = (specDir) =>
  execFileSync("git", hardenGitArgs(["status", "--porcelain", "--ignored", "--", ".qa/context.json"], specDir), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim() !== "";

/*
 * Ask for a context-map rebuild and disarm the stale flag only once the queue has accepted it. A
 * refused (""), rejected, thrown or unwired enqueue — or a run with no sha — keeps the flag armed,
 * so the next qualifying run retries instead of the heal being lost.
 */
function requestContextHeal(
  app: string,
  sha: string | undefined,
  enqueue: RewrittenEngineFactoryDeps["enqueueContextRun"],
): void {
  const keepArmed = (why: string): void => {
    console.warn(`[qa] WARNING: context-map rebuild for ${app} not enqueued (${why}); the stale flag stays armed for the next run.`);
  };
  if (!enqueue) return keepArmed("no rebuild trigger is wired");
  if (!sha) return keepArmed("the run has no sha to rebuild at");
  let pending: Promise<string>;
  try {
    pending = Promise.resolve(enqueue({ app, sha }));
  } catch (err) {
    return keepArmed(err instanceof Error ? err.message : String(err));
  }
  pending.then(
    (runId) => {
      if (runId) clearContextStale(app);
      else keepArmed("the queue refused new work");
    },
    (err: unknown) => keepArmed(err instanceof Error ? err.message : String(err)),
  );
}

/*
 * How long a run waits for the agent runtime to answer the step-limit read. The first read of a directory
 * starts that directory's agent instance, which is slow when cold, so the deadline is generous; a limit not
 * known by then is no limit, since it is optional context and never worth holding a run for.
 */
export const STEP_LIMIT_READ_TIMEOUT_MS = 30_000;

/* The runtime role each step-limit role runs as: the generator's session is the primary role's. */
const RUNTIME_ROLE_OF_STEP_LIMIT_ROLE: Readonly<Record<StepLimitRole, AgentRole>> = {
  generator: "primary",
  reviewer: "reviewer",
  explorer: "explorer",
};

/*
 * The step limit each role of ONE run runs under, read live from the agent runtime: a single read of `directory`
 * serves every role and every prompt of the run. The facade is resolved at the first ask, so a run that never
 * prompts reads nothing and a runtime switched between runs gives each run its own. A read that throws or outlasts
 * its deadline leaves every role without a limit and warns once. The baked config copy is never a substitute: it
 * can differ from what the server enforces.
 */
function stepLimitResolver(getAgentFacade: () => AgentFacade, directory: string): StepLimitFor {
  let read: Promise<StepLimits> | undefined;
  return async (role) => {
    read ??= readStepLimits(getAgentFacade, directory);
    return enforcedStepLimit((await read)[RUNTIME_ROLE_OF_STEP_LIMIT_ROLE[role]]);
  };
}

/* Never rejects: a failed read is no limit for any role, said once. */
async function readStepLimits(getAgentFacade: () => AgentFacade, directory: string): Promise<StepLimits> {
  try {
    return await withTimeout(getAgentFacade().stepLimits(directory), STEP_LIMIT_READ_TIMEOUT_MS, "step limit read");
  } catch (err) {
    console.warn(`[qa] WARNING: the step limits of ${directory} could not be read from the agent runtime (${err instanceof Error ? err.message : String(err)}); no prompt of this run states one.`);
    return {};
  }
}

/*
 * An app's orchestrator-only auth material directory (storageState / client certificate) under
 * QAYABA_ROOT/data — the qa-data volume, never mounted into the agents container. Removed with the
 * app on a purge.
 */
export function appAuthDir(root: string, appName: string): string {
  return join(root, "data", "auth", appName);
}

/*
 * An app's suite store under QAYABA_ROOT/data — the qa-data volume, never mounted into the agents container: the accepted e2e
 * suite and the login that was proven to work. Removed with the app on a purge.
 */
export function appSuiteStoreDir(root: string, appName: string): string {
  return join(root, "data", "suites", appName);
}

/*
 * The sandbox untrusted code runs as, or null when there is none. Its group is registered with the git hardening in the
 * same step: a git dir that group can write is never trusted, even when it is also the orchestrator's own group.
 */
export function resolveCodeSandbox(env: NodeJS.ProcessEnv, resolve: (env: NodeJS.ProcessEnv) => Sandbox | null = resolveSandbox): Sandbox | null {
  const sandbox = resolve(env);
  setSandboxGroup(sandbox?.gid);
  return sandbox;
}

export interface AcceptanceHarnessInput {
  app: AppConfig;
  /* The throwaway working copy an experiment arm delivered its specs in: the suite lives at <copyDir>/e2e. */
  copyDir: string;
  /* The launcher the specs run through; its run scope is the caller's (a script opens one, as the pipeline's run does). */
  exec: ExecSandboxPort;
  /* The host's agent sessions, for the reviewer. Absent: no reviewer is composed. */
  getAgentDeps?: () => AgentDeps;
}

export interface AcceptanceHarness {
  validation: ValidationPort;
  execution: ExecutionPort;
  objectiveSignal: ObjectiveSignalPort;
  review?: ReviewPort;
}

/*
 * The acceptance an experiment judges every arm by (accept-delivered-specs.use-case.ts), over the same parts the pipeline's own run uses: the
 * static gate, the Playwright runner, the change-coverage collector under the app's coverage policy (the value oracle off: it doubles a DEV
 * run and decides nothing here) and the independent reviewer. It is built over a copy of the working copy, never over a mirror.
 */
export function buildAcceptanceHarness(input: AcceptanceHarnessInput): AcceptanceHarness {
  const { app, copyDir, exec } = input;
  if (!app.dev?.baseUrl) throw new Error(`App "${app.name}" has no dev.baseUrl: its specs cannot be accepted without a DEV site`);
  const e2eRelDir = "e2e";
  const e2eDir = join(copyDir, e2eRelDir);
  const baseUrl = app.dev.baseUrl;
  const env = process.env;

  const validateDeps = createValidateDeps(exec);
  const staticGate = new StaticGateAdapter({
    typecheck: validateDeps.typecheck,
    lint: validateDeps.lint,
    listTests: validateDeps.listTests,
    checkManifest: validateDeps.checkManifest,
    validateAll: (specDir) => validateSpecs(specDir, validateDeps),
  });
  const refuseCode = (): never => {
    throw new Error("the acceptance harness has no code target");
  };
  const validation = new ValidationPortAdapter({ e2e: staticGate, code: { validate: async () => refuseCode() } as never }, { target: "e2e" });

  const e2eExecuteDeps: E2eExecuteDeps = { ...createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eTimeoutMs(env), exec, env.PW_ACTION_TIMEOUT_MS), recordAudit };
  const execution = new ExecutionPortAdapter(
    { e2e: new E2eExecutionStrategy((specDir, opts) => runE2E(specDir, opts, e2eExecuteDeps)), code: { run: async () => refuseCode() } as never },
    { target: "e2e", namespace: `${app.qa.testDataPrefix}-acceptance`, baseUrl, ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}) },
  );

  const policy = { mode: app.qa.changeCoverage?.mode ?? "signal", minRatio: app.qa.changeCoverage?.minRatio ?? 0.7 } as const;
  const objectiveSignal = new ObjectiveSignalPortAdapter(
    {
      collector: makeTargetCoverageCollector({ target: "e2e", repoDir: copyDir, e2eDir, changedFiles: [] }),
      decide: new DecideCoverageService(),
      oracle: new NullValueOracleAdapter(),
    },
    { policy, repoDir: copyDir, namespace: `${app.qa.testDataPrefix}-acceptance`, assembleChangeCoverage },
  );

  const getAgentDeps = input.getAgentDeps;
  const review = getAgentDeps
    ? new ReviewPortAdapter(
        {
          runtime: new AgentRuntimeAdapter({ open: async (agent, cwd, opts) => getAgentDeps().open(agent, cwd, { ...(opts?.signal ? { signal: opts.signal } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts?.model ? { model: opts.model } : {}), ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}) }) }, roleToAgentName),
          rendering: new PromptRenderingAdapter({ buildPromptAssembled, buildWorkerPromptAssembled, buildReviewerPromptAssembled, buildExplorerPrompt, specFileForFlow }),
          verdicts: new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict }),
        },
        { diff: "", mirrorDir: copyDir, e2eRelDir, appName: app.name, mode: "diff", target: "e2e", baseUrl, timeoutMs: REVIEWER_TIMEOUT_MS },
      )
    : undefined;

  return { validation, execution, objectiveSignal, ...(review ? { review } : {}) };
}

export function buildRewrittenCompositionConfig(
  app: AppConfig,
  deps: RewrittenEngineFactoryDeps,
  namespace: string,
  run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string; sha?: string },

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

  const codeSandbox = resolveCodeSandbox(deps.env ?? process.env);

  const coveragePolicy = { mode: app.qa.changeCoverage?.mode ?? "signal", minRatio: app.qa.changeCoverage?.minRatio ?? 0.7 } as const;
  const sidekickTimeoutMs = resolveSidekickTimeoutMsFromEnv();

  const mirrorRoot = deps.mirrorRoot ?? workdirRoot();
  /*
   * Placeholder static mirrorDir — the real per-run dir is whatever checkout(sha) returns.
   * This field satisfies CompositionConfig's static shape and seeds the coverage collector.
   * An unmeasured/mismatched repoDir reads as "unknown", which never blocks publish.
   */
  const mirrorDir = join(mirrorRoot, app.repo.replaceAll("/", "__"));
  const e2eDir = join(mirrorDir, e2eRelDir);
  /*
   * ONE resolver per run, shared by every session that states a limit: the generator, the reviewer and the explorer
   * all run in the primary mirror (the working copy checkout(sha) returns is this same directory), so one read of it
   * answers for all three. A host with no facade has no limit to give.
   */
  const stepLimitFor = deps.getAgentFacade ? stepLimitResolver(deps.getAgentFacade, mirrorDir) : undefined;

  /*
   * QAYABA_ROOT/data (the qa-data volume — NOT mounted into the agents container, only mirrors
   * is). authDir is where AuthSessionAdapter writes storageState/client.p12/cert.pass and where
   * every execute/DOM-capture spawn reads them back from: an orchestrator-only directory, never
   * the watched-repo mirror.
   */
  const root = qayabaRoot();
  const dataDir = qayabaDataDir();
  const authDir = appAuthDir(root, app.name);
  /*
   * The execution sandbox: every child that runs code an agent influenced (specs, the project's own tsc/eslint/--list and
   * installs, a login script, the watched repo's test command) starts through `exec`, and each run opens its scope
   * (work dir, auth copies, egress policy) in `execScope`.
   */
  const suiteAccount = suiteAccountFor(app, deps.env ?? process.env);
  const egressGate = egressGateFor(deps.env ?? process.env, codeSandbox);
  const execWiring = buildExecWiring({
    env: deps.env ?? process.env,
    sandbox: codeSandbox,
    authDir,
    mirrorRoot,
    egressOrigins: resolveRunOrigins(app, target, loadRegistryGroups(root)),
    ...(egressGate ? { egress: egressGate } : {}),
    ...(suiteAccount ? { suiteAccount } : {}),
  });
  const exec = execWiring.exec;


  /*
   * QA_CAMPAIGN_FREEZE (operator switch, off by default; read here once because qa-engine never reads process.env):
   * the run reads and writes no cross-run learning state. The collaborators below are left out, which the
   * composition root reads as "not wired" (a provable no-op), never as a stub that pretends to learn.
   */
  const campaignFrozen = resolveCampaignFreeze(deps.env ?? process.env);
  /* OFF by default (QA_REFLECTOR_ENABLED, see reflector-switch.ts): no reflection pass, and only proven rules reach a prompt. */
  const reflectorEnabled = resolveReflectorEnabled(deps.env ?? process.env);

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
   * The process-audit's context_stale flag (markContextStale, in processAudit's invalidateContext
   * below): a run that sees it skips the known-bad stored/disk map and requests a rebuild at its
   * own sha. Only a primary-repo e2e run that is not itself the rebuild qualifies: `!isCode`
   * (context maps are e2e-only), `run.mode !== "context"` (a context-mode run IS the rebuild) and
   * `!triggerService` (a service-triggered run's sha belongs to the service repo, not the primary).
   */
  const contextStale = !isCode && run.mode !== "context" && !triggerService && isContextStale(app.name);
  if (contextStale && campaignFrozen) {
    /* A campaign's queue holds only its own runs: the rebuild is left for after it, and the flag stays as the campaign found it. */
    console.log(`[qa] context map for ${app.name} was marked stale by the process audit — skipping the stored/disk map this run; the campaign freeze requests no rebuild.`);
  } else if (contextStale) {
    console.log(`[qa] context map for ${app.name} was marked stale by the process audit — skipping the stored/disk map this run and requesting a rebuild.`);
    requestContextHeal(app.name, run.sha, deps.enqueueContextRun);
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
  const loginRunner = createExecBinaryRunner({ exec, profile: "login", processKill: new ProcessKillAdapter() });
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
  /*
   * The run-level wall-clock deadline: one per run (this factory builds the engine for one run), armed by the use case
   * after classification and read by every agent turn of the run through the bounded runtime below, so no turn (a
   * regeneration, a fix-loop round, a repair, the coverage regen, the reviewer, the explorer, a sidekick) outlives it.
   * QA_RUN_TIME_BUDGET_MS_* override a kind of run's time; read here once because qa-engine never reads process.env. A
   * mistyped value throws. The reflector keeps the unbounded runtime: it runs after the run's verdict is made.
   */
  const runDeadline = new RunDeadline({ now: deps.now ?? Date.now, budgets: resolveRunTimeBudgets(deps.env ?? process.env) });
  const boundedRuntime = new RunDeadlineRuntime(runtimeAdapter, runDeadline, { hostPromptCapMs: agentPromptCapMs() });
  const rendering = new PromptRenderingAdapter({ buildPromptAssembled, buildWorkerPromptAssembled, buildReviewerPromptAssembled, buildExplorerPrompt, specFileForFlow });
  const verdicts = new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });

  /* Bounded contract-repair for malformed generator/reviewer verdicts — fail-closed if still invalid. */
  const repair: RepairPort = {
    checkGenerator: (text) => checkGeneratorVerdict(text),
    instruction: (kind, issues, opts) => repairInstruction(kind, issues, opts),
  };

  const generationUseCase = new GenerateTestsUseCase({
    runtime: boundedRuntime,
    rendering,
    verdicts,
    manifest: new ManifestRepositoryAdapter({ readManifest, reconcileManifest }),
    budget: new PromptBudgetAdapter(roleWindowBytes, capDiff, capText),
    repair,
    /* The transport's own deadline: the generator's time budget is never set above it. */
    promptCapMs: agentPromptCapMs(),
    /* QA_DIFF_TIME_BUDGET_MS_{TINY,FOCUSED,BROAD} override a tier's time; read here once because qa-engine never reads process.env. A mistyped value throws. */
    timeBudgets: resolveDiffTimeBudgets(deps.env ?? process.env),
  });


  const validateDeps = createValidateDeps(exec);
  const staticGate = new StaticGateAdapter({
    typecheck: validateDeps.typecheck,
    lint: validateDeps.lint,
    listTests: validateDeps.listTests,
    checkManifest: validateDeps.checkManifest,
    validateAll: (specDir) => validateSpecs(specDir, validateDeps),
  });
  /* Code-target Filter B: compile-feedback before execution. */
  const codeValidate = new CodeValidationStrategy((repoDir, opts) => validateCodeProject(repoDir, createCodeValidateDeps(exec), opts));


  const e2eExecuteDeps: E2eExecuteDeps = { ...createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eDefaultTimeoutMs, exec, pwActionTimeoutMs), recordAudit };
  const e2eCleanupDeps = createDefaultE2eCleanupDeps(new ProcessKillAdapter(), exec);
  /* One launcher-backed DOM capture for every grounding seam (Context Pack, review DOM, pre-exec). */
  const captureDomDeps = createCaptureDomDeps(exec);
  const e2e = new E2eExecutionStrategy((specDir, opts) => runE2E(specDir, opts, e2eExecuteDeps));

  const codeExecuteDeps = { ...createDefaultCodeExecuteDeps(exec), recordAudit };
  const codeSetupDeps = createDefaultCodeSetupDeps(codeSandbox, exec);
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
          await runCodeCoverage(mirrorDir, exec).catch(() => {});
          return rawCollector.collect(specDir, namespace, changedFiles);
        },
      }
    : rawCollector;

  const runCorruptedFaultInjection = ({ dir, baseUrl, namespace }: { dir: string; baseUrl: string; namespace: string }) =>
    /*
     * No --project, like a suite run: the repo owns its playwright.config.ts, and naming a project
     * it does not define fails the whole re-run, leaving the value score inconclusive.
     */
    runE2E(dir, { baseUrl, namespace, faultInject: true }, e2eExecuteDeps);

  const mutationOracleDeps = { spawn: (cmd: string, args: string[], o: { cwd: string }) => exec.spawn(cmd, args, { cwd: o.cwd, profile: "install" }), detectCodeProject, processKill: new ProcessKillAdapter() };

  /*
   * Honor YAML qa.valueOracle (and the shadow-aware default the CLI already reports).
   * "off" → NullValueOracleAdapter (no DEV re-run, no Stryker). "signal" → the target-specific
   * oracle (Stryker for code, fault-injection for e2e).
   */
  const valueOraclePolicy = resolveValueOraclePolicy(app.qa);
  const oracle = valueOraclePolicy === "off"
    ? new NullValueOracleAdapter()
    : isCode
      ? new StrykerMutationOracleAdapter(mutationOracleDeps)
      : new FaultInjectionOracleAdapter(runCorruptedFaultInjection, countInjectedResponses, app.dev?.baseUrl ?? "");

  /*
   * checkout(sha) resolves the real per-run mirrorDir and stages every declared sibling service's
   * READ-ONLY context into it (MultiRepoCheckoutAdapter, qa-engine-resident). Mirror ops are
   * curried here so the adapter never needs to know about MirrorDeps (a src/-only type) —
   * production always threads the module's own defaultMirrorDeps.
   */
  const multiRepoCheckout = new MultiRepoCheckoutAdapter(
    {
      primaryRepo: app.repo,
      baseBranch: app.baseBranch ?? "main",
      services: app.services ?? [],
      ...(triggerService ? { triggerService: { repo: triggerService.repo, ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) } } : {}),
      isCode,
    },
    {
      ensureMirror: (repo, sha) => mirror.ensureMirror(repo, sha, defaultMirrorDeps),
      ensureMirrorAtBranch: (repo, branch) => mirror.ensureMirrorAtBranch(repo, branch, defaultMirrorDeps),
      stageServiceContext: (input) => stage(input),
    },
  );
  const checkout = (checkoutSha: Sha): Promise<string> => multiRepoCheckout.checkout(checkoutSha);


  /* Built even when frozen (cheap, no I/O): the frozen config simply does not hand it to the engine. */
  const learningRepo = new SqliteLearningRepository(historyLearningStore(app.name), { reflectorUnproven: reflectorEnabled });


  const setupAdapter = buildSetupAdapter(exec, codeSandbox);
  /*
   * `??`, not `||`: app.qa.explorer is a tri-state (true/false/unconfigured). An explicit
   * `explorer: false` must win over the services-length auto-detect, never be swallowed by it —
   * `||` treated false and unconfigured identically, silently ignoring an operator's opt-out.
   */
  const shouldExplore = app.qa.explorer ?? (app.services?.length ?? 0) > 0;

  const explorerBriefAdapter = new ExplorerBriefSessionAdapter(
    {
      repo: app.repo,
      e2eRelDir,
      namespace,
      needsReview: app.qa.needsReview,
      target,
      mode: run.mode,
      appName: app.name,
      timeoutMs: EXPLORER_TIMEOUT_MS,
      ...(app.dev?.baseUrl ? { baseUrl: app.dev.baseUrl } : {}),
      ...(run.guidance ? { guidance: run.guidance } : {}),
      ...(triggerService
        ? { triggerService: { repo: triggerService.repo, ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) } }
        : {}),
    },
    { runtime: boundedRuntime, parseBrief: parseExplorationBrief, buildPrompt: buildExplorerPrompt, serviceContextDir, stepLimitFor },
  );

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
     * Per-delegation wall-clock cap — env-tunable here (the shell), never read by qa-engine's
     * composition-root itself. Absent → composition-root's own hardcoded default (420_000).
     */
    ...(sidekickTimeoutMs !== undefined ? { sidekickTimeoutMs } : {}),
    /*
     * The same coveragePolicy that configures the objective signal (computed once, above), so
     * the policy that measures coverage and the one that decides whether it blocks never diverge.
     */
    coveragePolicyMode: coveragePolicy.mode,
    agentTimeoutMs: agentTimeout(run.mode),
    ...(app.qa.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: app.qa.wallClockBudgetMs } : {}),
    ...(app.qa.iterationBudget !== undefined ? { iterationBudget: app.qa.iterationBudget } : {}),

    diff: "",

    vcs,
    generationUseCase,
    ...(stepLimitFor ? { stepLimitFor } : {}),
    runDeadline,
    reviewRuntime: {
      runtime: boundedRuntime,
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

    /*
     * contextPackDeps.domDeps is ALWAYS overridden (regardless of shouldExplore) so the
     * pre-generation DOM capture reads auth material from the orchestrator-only authDir, never
     * from the mirror — the qa-engine default (defaultCaptureDomDeps) would
     * otherwise derive credential paths from e2eDir itself.
     */
    groundingCollaborators: {
      ...(shouldExplore && !isCode
        ? {
            exploreBrief: (args) => explorerBriefAdapter.explore(args),
          }
        : {}),
      contextPackDeps: { ...defaultContextPackDeps, domDeps: captureDomDeps },
      /*
       * The DB (history.ts's context_maps table) is the engine's source of truth for the
       * FE<->BE architecture map — it survives regardless of shadow. The repo file on disk is only a
       * fallback (e.g. before any context run has ever completed for this app, or a fresh clone).
       * A `contextStale` flag seen above means the process audit already judged the stored (and
       * any repo-file) map wrong — this run grounds without it; the rebuild requested above (or a
       * manual context run) replaces the map for later runs.
       */
      loadContextMap: (specDir: string) => {
        if (contextStale) return undefined;
        const stored = loadStoredContextMap(app.name);
        if (stored) return stored.data;
        return loadContextMapFromDisk(specDir);
      },
    },
    reviewDomGroundingCollaborators: { captureDomDeps },
    preExecGroundingCollaborators: { captureDomDeps },
    /*
     * Per-run lastIndexedSha sidecar (cheap JSON under QAYABA_ROOT/data). Always supplied —
     * the use-case phase is a no-op unless wireBridges also builds codeGraph from codebaseMemory
     * (gated by structuralSignalsOn). First-time full index of an unresolved project is now
     * LazyProjectCodeGraphAdapter.syncTo (index_repository with repo_path only).
     */
    indexStatus: new IndexStatusAdapter(dataDir),
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
              expandEnv(readFileSync(join(qayabaRoot(), "config", "apps", `${name}.yaml`), "utf8"))),
          },
        }
      : {}),

    ...(structuralSignalsOn && app.services?.length && app.boundaries?.length
      ? { crossRepoImpact: { mirrorRoot, codebaseMemory: new CodebaseMemoryClient(runner), runner } }
      : {}),

    execScope: execWiring.execScope,
    /*
     * The run_spec loop: composed for an e2e app whenever the host has a registry; whether a run is granted it is the app's
     * qa.closedLoop (or the run's own choice), decided when the run opens it. The generator's role is read from the agent
     * facade as it is now (the runtime is switchable): only OpenCode can call a custom tool, and a host that cannot say is
     * not assumed to be. The account lock is the process's, since the key is the app's login and the processes share nothing else.
     */
    ...(deps.closedLoopRegistry && !isCode && app.dev?.baseUrl
      ? {
          closedLoop: {
            registry: deps.closedLoopRegistry,
            setting: {
              enabled: app.qa.closedLoop?.enabled === true,
              limits: {
                maxCalls: app.qa.closedLoop?.maxCalls ?? DEFAULT_CLOSED_LOOP_LIMITS.maxCalls,
                perCallMs: app.qa.closedLoop?.perCallMs ?? DEFAULT_CLOSED_LOOP_LIMITS.perCallMs,
                maxDevWrites: app.qa.closedLoop?.maxDevWrites ?? DEFAULT_CLOSED_LOOP_LIMITS.maxDevWrites,
              },
            },
            generatorRuntimeCanCall: () => (deps.getAgentFacade ? assignmentForRole(deps.getAgentFacade().config, "primary").provider === "opencode" : false),
            account: `${app.name}/${app.auth?.usernameEnv ?? "public"}`,
            lock: PROCESS_ACCOUNT_LOCK,
            deadline: runDeadline,
            redact: (text: string) => redactionPort.redact(redactByValue(text)),
          },
        }
      : {}),
    ...(app.dev?.baseUrl ? { baseUrl: app.dev.baseUrl } : {}),
    ...(!isCode && app.dev?.baseUrl
      ? {
          authSession: new AuthSessionAdapter({
            env: process.env,
            authDir,
            ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}),
            ...(pwActionTimeoutMs !== undefined ? { actionTimeoutMs: pwActionTimeoutMs } : {}),
            /*
             * The production switch for structural login discovery: for an app on the stock login
             * seed it tries the login itself first (one submit per phase) and only a positively
             * evidenced failure ends the run. Removing this object restores the stock-seed-only login.
             * Its note passes through the same redaction every other text leaving the system does.
             */
            discovery: {
              discoverLogin: createDiscoverLogin({ runner: loginRunner, writeScript: (name, content) => exec.writeScript(name, content) }),
              redact: (text: string) => redactionPort.redact(text),
              loadContextMap: loadContextMapFromDisk,
            },
            /* The login child is the one process that carries the account: the launcher's `login` profile. It writes the session in the run's own `login` folder, and the adapter brings a confirmed one into the auth directory. */
            loginStaging: () => ({ dir: join(exec.workDir(), "login"), root: exec.workDir() }),
            spawnSetup: async (specDir, env, signal) => {
              const callDir = exec.allocDir("auth-setup", ["results"]);
              try {
                const result = await loginRunner.run({
                  command: "npx",
                  args: ["playwright", "test", "--project=setup", `--output=${join(callDir, "results")}`],
                  cwd: specDir,
                  env,
                  timeoutMs: 120_000,
                  ...(signal ? { signal } : {}),
                });
                const logs = `${result.stdout}\n${result.stderr}`;
                return {
                  exitCode: result.timedOut ? 1 : (result.exitCode ?? 1),
                  logs: result.timedOut ? `auth setup timed out\n${logs}` : logs,
                };
              } finally {
                rmSync(callDir, { recursive: true, force: true });
              }
            },
          }),
          ...(app.auth ? { auth: app.auth } : {}),
        }
      : {}),
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

    ...(campaignFrozen ? {} : { learningRepo }),
    /*
     * This factory is the one module that may import both qa-engine @contexts aliases and root
     * src/, so it is the only place that can construct ReflectorPortAdapter: same runtimeAdapter
     * as review, same learningRepo, and host-side backfill via updateRunOutcomeReflection.
     * REFLECTOR_TIMEOUT_MS parsed here with Number(process.env.X) || default; unset falls back
     * to the adapter's REFLECT_TIMEOUT_MS (60_000).
     */
    ...(campaignFrozen || !reflectorEnabled ? {} : { reflectorPort: new ReflectorPortAdapter({
      runtime: runtimeAdapter,
      repo: learningRepo,

      backfill: (runId, refl) => updateRunOutcomeReflection(runId, refl as import("../types").StructuredReflection),
      cwd: mirrorDir,
      app: app.name,
      timeoutMs: Number((deps.env ?? process.env).REFLECTOR_TIMEOUT_MS) || REFLECT_TIMEOUT_MS,
    }) }),

    ...(campaignFrozen ? {} : { processAudit: new ProcessAuditPortAdapter({
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
    }) }),
    /*
     * CurriculumPort — per-app scenario-archetype prior. Constructed here because its store is
     * history.ts (src-only; qa-engine may never import it). Wired unconditionally: measure-and-rank
     * only, never gates a verdict, publish, or coverage decision. Left out under QA_CAMPAIGN_FREEZE.
     */
    ...(campaignFrozen ? {} : { curriculumPort: new CurriculumPortAdapter(app.name, loadCurriculum, saveCurriculum) }),
    /*
     * ContextMapCapturePort — write side of the FE<->BE architecture map. Constructed here for the
     * same reason curriculumPort is: its store is history.ts (src-only; qa-engine may never import
     * it). Wired unconditionally: a clean context-mode pass is the only run that ever invokes it.
     * Storing a fresh map disarms the process audit's stale flag, whoever started the context run
     * (a heal, a manual or onboarding run, the server or the CLI). Only a map the run wrote is
     * fresh: a committed map left untouched is neither stored nor disarms the flag.
     */
    contextMapCapture: new ContextMapCapturePortAdapter(storeFreshContextMap, contextMapWrittenThisRun),
    /*
     * The accepted e2e suite of this app, in the qa-data volume (never mounted into the agents container). A checkout wipes every
     * untracked file of the mirror, and shadow mode never publishes: without the store every run would start cold, re-seed the
     * stock login and ask the agent to author it again. E2e only; the code target keeps its tests in the repo's own framework.
     * Under QA_CAMPAIGN_FREEZE the store is read-only: the suite is cross-run state like the learning the freeze already withholds,
     * and a campaign seeds the store itself (scripts/warm-suite.ts seed-store) before each arm-run.
     */
    ...(!isCode
      ? { suiteStore: new SuiteStoreAdapter({ storeDir: appSuiteStoreDir(root, app.name), app: app.name, repo: app.repo, specRelDir: e2eRelDir, seedDir: join(qayabaRoot(), "config", "e2e"), listTracked: gitListTracked(runner), now: () => new Date(), readOnly: campaignFrozen }) }
      : {}),
    ...(observer ? { observer } : {}),
  };
}


/* The agent transport the engine opens its sessions through: the host's, with live observation, the stall watchdog and usage, and the run_spec registry told which sessions the generator opens for which run. */
export function engineAgentDeps(deps: Pick<RewrittenEngineFactoryDeps, "getAgentDeps" | "closedLoopRegistry">): AgentDeps {
  const registry = deps.closedLoopRegistry;
  return withUsageSink(
    withStallWatchdog(
      withSessionRegistration(deps.getAgentDeps(), {
        register: registerRunSession,
        unregister: unregisterRunSession,
        ...(registry ? { bind: (session) => registry.bindSession(session), unbind: (sessionId) => registry.unbindSession(sessionId) } : {}),
      }),
      { stallMs: stallMs() },
    ),
  );
}

export function createRewrittenEngineFactory(
  deps: RewrittenEngineFactoryDeps,
): (appConfig: AppConfig, namespace: string, run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string; sha?: string }, observer?: ObserverPort, previousNamespace?: string) => RunPipelinePort {
  const env = deps.env ?? process.env;
  const wrappedDeps: RewrittenEngineFactoryDeps = {
    ...deps,
    getAgentDeps: () => engineAgentDeps(deps),
  };
  return (appConfig: AppConfig, namespace: string, run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string; sha?: string }, observer?: ObserverPort): RunPipelinePort => {
    const cfg = buildRewrittenCompositionConfig(appConfig, wrappedDeps, namespace, run, observer);
    return buildProduction(env, cfg);
  };
}
