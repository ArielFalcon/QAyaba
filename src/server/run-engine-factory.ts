/*
 * Composition root: maps AppConfig into a qa-engine EngineRootDeps and returns
 * buildEngine(...). Wires host collaborators (agent runtime, GitHub, runners).
 * Env reads for execution timeouts stay here. Agent remains read-only on watched repos.
 */

import { appLogger } from "../integrations/redacting-logger";
import { join } from "node:path";
import { DELEGATIONS_DIR, qayabaDataDir, qayabaRoot } from "../paths";
import { readFileSync, mkdirSync, writeFileSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../integrations/opencode-client";
import { reviewerTimeoutMs, agentPromptCapMs, agentConfigFacts, maxStepsFromConfig, setSessionToolDeny, withTimeout } from "../integrations/opencode-client";
import { AGENT_NAME_FOR_ROLE, assignmentForRole, type AgentFacade, type AgentRuntimeConfig, type ModelWindows, type StepLimits } from "../agent-runtime/types";
import { reviewerIndependence } from "../agent-runtime/config";
import { enforcedStepLimit } from "../agent-runtime/step-limit";

import {
  withUsageSink,
  withStallWatchdog,
  withSessionRegistration,
  registerRunSession,
  unregisterRunSession,
  stallMs,
} from "../integrations/opencode-client";
import type { RunPipelinePort, ObserverPort } from "@contexts/run-orchestration/application/index.ts";
import {
  RequestContextHeal,
  agentBrowserEnabled,
  baseBranchOf,
  closedLoopEnabled,
  contextMapFitsRun,
  deployGateTiming,
  fixLoopMaxRetries,
  parseNameStatusZ,
  resolveDomPack,
  resolveIntentLock,
  serviceTopologyWired,
  staleFlagHeal,
  staleMapHeal,
  type ChangedFile,
  type EnqueueContextRunPort,
} from "@contexts/run-orchestration/application/index";
import { buildEngine, codeGraphFor, type EngineRootDeps } from "./engine-root";
import type { PublishDeps } from "./engine-root";
import { createDiscoverLogin } from "@contexts/app-catalog/infrastructure/login-discovery/login-discovery.runner";
import { createCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot";
import { domCaptureObserver } from "@contexts/generation/infrastructure/dom-capture-trace";
import { traceValidateDeps } from "@contexts/test-execution/infrastructure/static-gate.trace";
import { synthesizeReportSpans } from "@contexts/test-execution/infrastructure/report-spans";
import { SqliteSpecSnapshotAdapter } from "./spec-snapshot-sqlite.adapter";
import { SqlitePlanSnapshotAdapter } from "./plan-snapshot-sqlite.adapter";
import { defaultContextPackDeps } from "@contexts/generation/infrastructure/context-pack";
import { loadContextMapFromDisk } from "@contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter";
import { ContextMapCapturePortAdapter, type ContextMapSave, type ContextMapWrittenThisRun } from "@contexts/generation/infrastructure/adapters/context-map-capture-port.adapter";
import { Sha } from "@kernel/sha";
import { assertCommitSha } from "@kernel/git-revision";
import type { CommitAncestryPort } from "@kernel/ports/commit-ancestry.port";
import { closedLoopLimitsOf } from "@contexts/agent-tools/application/index";
import { resolveCoordinationSettings } from "@kernel/coordination";
import { DevLease } from "@contexts/test-execution/application/index";
import { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry";
import type { AgentBrowserRegistry } from "@contexts/agent-tools/infrastructure/agent-browser-registry";
import type { GeolocationRegistry } from "@contexts/agent-tools/infrastructure/geolocation-registry";
import type { CodeGraphToolRegistry } from "@contexts/agent-tools/infrastructure/code-graph-tool-registry";
import { PlaywrightAgentBrowserHost } from "@contexts/test-execution/infrastructure/agent-browser/playwright-agent-browser.host";
import { SandboxedChromiumLauncher } from "@contexts/test-execution/infrastructure/agent-browser/chromium-sandbox.launcher";
import { loadPlaywrightChromium } from "@contexts/test-execution/infrastructure/agent-browser/playwright-core.loader";
import { redactByValue } from "../../qa-engine/src/shared-kernel/run-secret-redaction";
import { ValidationPortAdapter } from "@contexts/test-execution/infrastructure/adapters/validation-port.adapter";
import { ExecutionPortAdapter } from "@contexts/test-execution/infrastructure/adapters/execution-port.adapter";
import { ObjectiveSignalPortAdapter } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter";
import { ReviewPortAdapter } from "@contexts/generation/infrastructure/adapters/review-port.adapter";
import { DecideCoverageService, bundleMutationEnabled, resolveCoveragePolicy } from "@contexts/objective-signal/application/index";
import type { ReviewPort } from "@contexts/generation/application/index.ts";
import type { ExecutionPort, ValidationPort } from "@contexts/test-execution/application/index.ts";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/index.ts";
import type { AgentRole } from "@kernel/agent-role";
import type { RunMode } from "@kernel/run-mode";

import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter";
import type { ChangeSet, VcsReadPort } from "@contexts/change-analysis/application/index";
import { GenerateTestsUseCase } from "@contexts/generation/application/index";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter";
import { RunDeadline } from "@contexts/run-orchestration/application/index";
import type { ArchitectureContext } from "@contexts/generation/application/index.ts";
import type { TelemetryClock, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { CONTEXT_MAP_MAX_AGE_MS, contextMapResultCount, type ContextProvenance } from "@kernel/telemetry/context-provenance";
import { withPromptBodies } from "../telemetry/with-prompt-bodies";
import { hashStaticPrompts } from "../../qa-engine/src/contexts/run-orchestration/infrastructure/static-prompt-hash";
import { withTurnTelemetry } from "@contexts/generation/infrastructure/telemetry/with-turn-telemetry";
import { agentTurnTraces } from "@contexts/generation/infrastructure/telemetry/turn-trace-registry";
import type { StepIntentContext } from "@contexts/generation/application/index";
import { watchSpanForHost } from "../telemetry/host-listeners";
import { SYSTEM_CLOCK } from "./run-trace";
import { stepIntentContextFor } from "./turn-telemetry-config";
import { resolveRunTimeBudgets } from "@contexts/run-orchestration/application/index";
import { RunDeadlineRuntime } from "@contexts/run-orchestration/infrastructure/run-deadline-runtime.adapter";
import { RunRoundRuntime } from "@contexts/run-orchestration/infrastructure/run-round-runtime.adapter";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter";
import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs";
import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy";
import { countInjectedResponses } from "@contexts/objective-signal/infrastructure/fault-injection-counter-reader";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter";
import type { GitHubHttpDeps } from "@contexts/workspace-and-publication/infrastructure/github-http";
import { SetupAdapter, nodeFsDeps } from "@contexts/workspace-and-publication/infrastructure/setup.adapter";
import { WriteConfinementAdapter } from "@contexts/workspace-and-publication/infrastructure/write-confinement.adapter";
import { MirrorGcAdapter } from "@contexts/workspace-and-publication/infrastructure/mirror-gc.adapter";
import { SuiteStoreAdapter, gitListTracked } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector";
import { assembleChangeCoverage } from "@contexts/objective-signal/application/index";


import { SandboxedBinaryRunnerAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter";
import { ProcessKillAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter";

import { GitCoChangeAdapter } from "../../qa-engine/src/shared-infrastructure/code-graph/git-co-change.adapter";


import {
  buildPromptAssembled,
  buildReviewerPromptAssembled,
  specFileForFlow,
} from "@contexts/generation/infrastructure/prompt-builders/prompts";
import { checkGeneratorVerdict, parseReviewerVerdict, parseVerdict, repairInstruction } from "@contexts/generation/application/index";
import type { StepLimitFor, StepLimitRole } from "@contexts/generation/application/index.ts";
import { MultiRepoCheckoutAdapter } from "@contexts/workspace-and-publication/infrastructure/adapters/multi-repo-checkout.adapter";
import { RunContextBudget, WORKING_ROOM_HISTORY_TURNS, type RecordedTurnRow } from "../agent-runtime/run-context-budget";
import type { RepairPort } from "@contexts/generation/application/index.ts";

import {
  runE2E,
  createDefaultE2eExecuteDeps,
  createDefaultE2eCleanupDeps,
  e2eTimeoutMs,
  type E2eExecuteDeps,
} from "../../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner";

import {
  validateSpecs,
  createValidateDeps,
  fixLintedSpecs,
} from "../../qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks";
import { resolveSandbox, openInstallTree, sealInstallTree, type Sandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import type { ExecSandboxPort } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { createExecBinaryRunner } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-binary-runner";
import { buildExecWiring } from "./exec-sandbox-factory";
import { egressGateFor, loadRegistryGroups } from "./egress-wiring";
import { blockedHostMatcher, resolveRunOrigins, suiteAccountFor } from "@contexts/test-execution/application/index";
import { setSandboxGroup } from "../../qa-engine/src/shared-infrastructure/process-sandbox/git-hardening";
import type { EffectiveConfig, GroundingInput } from "../contract/commands";
import { requireEnv } from "../util/env";
import { RedactionPortAdapter, redactSourceForModel } from "../orchestrator/sanitizer";
import { ensureMirror, ensureMirrorAtBranch, defaultMirrorDeps, workdirRoot, realGit, authHeaderArgs, hardenGitArgs, assertTrustedGitTree } from "../integrations/repo-mirror";
import { stageServiceContext, serviceContextDir, type StageServiceContextInput, type StagedServiceContext } from "@contexts/service-topology/application/index";
import { defaultStageDeps } from "./service-context";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import type { RunFreeze } from "./run-freeze";
import { SqliteLessonStoreAdapter } from "./lesson-store-sqlite-adapter";
import { ProcessAuditPortAdapter } from "@contexts/cross-run-learning/infrastructure/process-audit-port.adapter";
import { YamlBoundaryProfileAdapter } from "@contexts/service-topology/infrastructure/yaml-boundary-profile.adapter";
import { expandEnv } from "@contexts/app-catalog/application/index";
import { getHistory } from "./persistence/index";
import { historyPhaseHistory } from "./phase-history";
import { activeEnvironment } from "../settings/active";
import { activeSettings } from "../settings/store";

/*
 * Role→agent-name mapping for AgentRuntimeAdapter. Also the durable coordination telemetry
 * path — composition writes it and the control plane reads it; they must agree.
 */
export function resolveCoordinationTelemetryPath(): string {
  return (
    activeSettings().agent.coordinationTelemetryPath ||
    join(qayabaDataDir(), "coordination-events.jsonl")
  );
}

export function roleToAgentName(role: AgentRole): string {
  return AGENT_NAME_FOR_ROLE[role];
}


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
 * The identity comes from the environment the caller passes in. The engine's git-write seam stays token-agnostic.
 */
function withPublishGitDecorations(git: GitFn, env: NodeJS.ProcessEnv): GitFn {
  return (args, cwd) => {
    if (args[0] === "push") return git([...authHeaderArgs(), ...args], cwd);
    if (args[0] === "commit") {
      const name = env.GIT_AUTHOR_NAME ?? "qayaba";
      const email = env.GIT_AUTHOR_EMAIL ?? "qayaba@users.noreply.github.com";
      return git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args], cwd);
    }
    return git(args, cwd);
  };
}

/*
 * What the shell gives the publish step of a run: git with the push credentials and the commit identity
 * applied, and the local-exclude writer. `git`/`writeExcludesFn` are injectable so tests see the same
 * decorated argv as production.
 */
export function publishWiring(
  mode: RunMode,
  git: GitFn = realGit,
  writeExcludesFn: (dir: string, patterns: readonly string[]) => void = writeExcludes,
  env: NodeJS.ProcessEnv = activeEnvironment(),
): PublishDeps {
  return { mode, git: withPublishGitDecorations(git, env), writeExcludes: writeExcludesFn };
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
 * authHeaders() as an injected closure and reads no environment itself (qa-engine reads none
 * at all), so this composition root is the sole credential-locality seam for
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
    runner: createExecBinaryRunner({ exec, profile: "install", commandClass: "npm-ci", processKill: new ProcessKillAdapter() }),
    seedDir: join(qayabaRoot(), "config", "e2e"),
    installGuard: { open: (dir) => openInstallTree(dir, sandbox), seal: (dir) => sealInstallTree(dir, sandbox) },
  });
}


/*
 * DEV is held through one lease for the whole process, whichever run an action belongs to: two uses of one test account never
 * interleave, and an action that may write holds DEV alone. The proxy has no read-only mode yet, so nothing is built to believe a
 * read-only claim and every action is exclusive; the lease is built to, once there is one to say so.
 */
const PROCESS_ACCOUNT_LOCK = new DevLease();

/* The most a browser process of the agent tools lives, whatever happens to the orchestrator: longer than any run. */
const AGENT_BROWSER_LIFETIME_SECONDS = 3 * 60 * 60;

/* The host's already-built real collaborators this factory reuses instead of re-assembling. */
export interface RunEngineFactoryDeps {
  /*
   * Reads the SAME AgentDeps facade the host's currentAgentDeps() resolves (src/server/wire-app.ts) — the
   * real :4097 supervisor, not a second AgentRuntimeManager instance.
   */
  /* The host's agent sessions. A run passes the context that classifies its agents' steps for the trace; a host that traces nothing ignores it. */
  getAgentDeps: (turn?: TurnTelemetryContext) => AgentDeps;
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
   * The process's telemetry port (src/telemetry/process-telemetry.ts) and the wall clock it was built on. Absent: nothing is
   * traced. The clock times the run's phases and starts and ends their spans, so the phase record and the trace cannot disagree.
   */
  telemetry?: TelemetryPort;
  clock?: TelemetryClock;
  /*
   * Where the generator's sessions find the run's run_spec loop. One per process, shared with the tools endpoint that serves the
   * tool's calls. Absent: no run is ever granted the tool.
   */
  closedLoopRegistry?: ClosedLoopRegistry;
  /*
   * Where the authoring agents' sessions find the run's authenticated browser. One per process, shared with the tools endpoint
   * that serves the browser's calls. Absent: no run is ever granted the browser.
   */
  agentBrowserRegistry?: AgentBrowserRegistry;
  /*
   * Where the authoring agents' sessions find the run's location. One per process, shared with the tools endpoint that serves the
   * set_geolocation tool. Absent: no run carries an authoring location.
   */
  geolocationRegistry?: GeolocationRegistry;
  /*
   * Where the lead's sessions find the run's code graph. One per process, shared with the tools endpoint that serves the
   * codegraph_explore tool. Absent: no run grants the lead the code graph.
   */
  codeGraphRegistry?: CodeGraphToolRegistry;
  mirrorRoot?: string;
  /* Test seam: inject spies for the two mirror primitives instead of real git/disk. */
  mirror?: {
    ensureMirror: typeof ensureMirror;
    ensureMirrorAtBranch: typeof ensureMirrorAtBranch;
  };
  /* Test seam: inject a spy/no-op for service-context staging instead of real disk/git. */
  stageServiceContext?: (input: StageServiceContextInput) => Promise<StagedServiceContext>;
  /*
   * The process-audit context-heal's REBUILD side: enqueue a `mode: context` run of `app` at `sha`
   * and return its run id, or "" when the queue refuses new work. Called when a run sees the
   * context_stale flag (see RequestContextHeal). A failure to enqueue never blocks or fails
   * the run that triggered it.
   */
  enqueueContextRun?: EnqueueContextRunPort;
  /*
   * How the files differ between the commit a stored context map was built at and the run's commit, read in the primary
   * mirror; undefined when they cannot be compared. Test seam: the default asks git.
   */
  contextMapChanges?: (repoDir: string, fromSha: string, toSha: string) => ChangedFile[] | undefined;
}

/* `git diff` between two commits of the mirror; a failure (a commit the mirror does not hold, a commit that is not a sha) is "cannot compare", never a guess. */
export function gitChangedFiles(repoDir: string, fromSha: string, toSha: string): ChangedFile[] | undefined {
  try {
    /* The commits come from stored records and agent-written files: a value that is not a sha could be read by git as an option. */
    assertCommitSha(fromSha);
    assertCommitSha(toSha);
    const out = execFileSync("git", hardenGitArgs(["diff", "--name-status", "--no-renames", "-z", fromSha, toSha, "--"], repoDir), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseNameStatusZ(out);
  } catch (err) {
    appLogger.warn(`[qa] WARNING: the context map's commit ${fromSha.slice(0, 7)} could not be compared with ${toSha.slice(0, 7)} (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); the map is not reused.`);
    /* mutation-scope:begin context-map-compare-fallback */
    return undefined;
  }
}

/* The app commits a run has already asked a context-map rebuild for, in this process: the next run at the same commit does not ask again. */
/* Bounded contract-repair for a malformed generator/reviewer verdict: one tools-disabled re-prompt, fail-closed if still invalid. */
const contractRepair: RepairPort = {
  checkGenerator: (text) => checkGeneratorVerdict(text),
  instruction: (kind, issues, opts) => repairInstruction(kind, issues, opts),
};

const contextHealRequested = new Set<string>();

/* Persist a context run's validated map; a fresh map replaces the one the stale flag condemned. */
const storeFreshContextMap: ContextMapSave = (app, sha, map) => {
  getHistory().contexts.saveContextMap(app, sha, map);
  getHistory().contexts.clearContextStale(app);
};

/* The mirror's git status for the spec dir's context map: any entry means this run wrote it. */
const contextMapWrittenThisRun: ContextMapWrittenThisRun = (specDir) =>
  execFileSync("git", hardenGitArgs(["status", "--porcelain", "--ignored", "--", ".qa/context.json"], specDir), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim() !== "";
    /* mutation-scope:end context-map-compare-fallback */

/*
 * How long a run waits for the agent runtime to answer the step-limit read. The first read of a directory
 * starts that directory's agent instance, which is slow when cold, so the deadline is generous; a limit not
 * known by then is no limit, since it is optional context and never worth holding a run for.
 */
export const STEP_LIMIT_READ_TIMEOUT_MS = 30_000;

/* The runtime role each step-limit role runs as. */
const RUNTIME_ROLE_OF_STEP_LIMIT_ROLE: Readonly<Record<StepLimitRole, AgentRole>> = {
  author: "author",
  lead: "lead",
  reviewer: "reviewer",
};

/*
 * The step limit each role of ONE run runs under, read live from the agent runtime: a single read of `directory`
 * serves every role and every prompt of the run. The facade is resolved at the first ask, so a run that never
 * prompts reads nothing and a runtime switched between runs gives each run its own. A read that throws or outlasts
 * its deadline leaves every role without a limit and warns once. The baked config copy is never a substitute: it
 * can differ from what the server enforces. The same first ask installs, into the run's own context budget, the
 * context window the runtime reports for each model, the models the roles are assigned and the working room estimated
 * from the recorded turns, which budget every prompt of the run (every prompt that states a limit awaits this read first).
 */
function stepLimitResolver(getAgentFacade: () => AgentFacade, directory: string, context: RunContextBudget, loadHistory: () => RecordedTurnRow[]): StepLimitFor {
  let read: Promise<StepLimits> | undefined;
  let facade: AgentFacade | undefined;
  const facadeOnce = (): AgentFacade => (facade ??= getAgentFacade());
  return async (role) => {
    read ??= Promise.all([readStepLimits(facadeOnce, directory), readModelWindows(facadeOnce, directory)]).then(([limits, windows]) => {
      installRunContext(context, facadeOnce, windows, limits, loadHistory);
      return limits;
    });
    return enforcedStepLimit((await read)[RUNTIME_ROLE_OF_STEP_LIMIT_ROLE[role]]);
  };
}

/* Never rejects: a failed read is no limit for any role, said once. */
async function readStepLimits(getAgentFacade: () => AgentFacade, directory: string): Promise<StepLimits> {
  try {
    return await withTimeout(getAgentFacade().stepLimits(directory), STEP_LIMIT_READ_TIMEOUT_MS, "step limit read");
  } catch (err) {
    appLogger.warn(`[qa] WARNING: the step limits of ${directory} could not be read from the agent runtime (${err instanceof Error ? err.message : String(err)}); no prompt of this run states one.`);
    return {};
  }
}

/* Never rejects: a failed read leaves every window unknown for this run, said once; no previous run's windows stand in, and an unknown window cuts nothing. */
async function readModelWindows(getAgentFacade: () => AgentFacade, directory: string): Promise<ModelWindows | undefined> {
  let facade: AgentFacade;
  try {
    facade = getAgentFacade();
  } catch {
    return undefined; /* the step-limit read of the same ask reports a facade that cannot be resolved */
  }
  if (!facade.modelWindows) return undefined;
  try {
    return await withTimeout(facade.modelWindows(directory), STEP_LIMIT_READ_TIMEOUT_MS, "model window read");
  } catch (err) {
    appLogger.warn(`[qa] WARNING: the model context windows of ${directory} could not be read from the agent runtime (${err instanceof Error ? err.message : String(err)}); no prompt of this run is cut or split for a window.`);
    return undefined;
  }
}

/* The windows, the role -> model assignments and the recorded turns of the run's one read, installed in its context budget. A history that cannot be read is an empty one: the working room then starts cold from the step limits. */
function installRunContext(context: RunContextBudget, getAgentFacade: () => AgentFacade, windows: ModelWindows | undefined, stepLimits: StepLimits, loadHistory: () => RecordedTurnRow[]): void {
  let config: AgentRuntimeConfig | undefined;
  try {
    config = getAgentFacade().config;
  } catch {
    config = undefined;
  }
  let history: RecordedTurnRow[] = [];
  try {
    history = loadHistory();
  } catch (err) {
    appLogger.warn(`[qa] WARNING: the recorded turns could not be read (${err instanceof Error ? err.message : String(err)}); the working room of this run's turns starts from the step limits.`);
  }
  context.install({ windows, config, stepLimits, history });
}

/*
 * An app's orchestrator-only auth material directory (storageState / client certificate) under
 * QAYABA_ROOT/data — the qayaba-data volume, never mounted into the agents container. Removed with the
 * app on a purge.
 */
export function appAuthDir(root: string, appName: string): string {
  return join(root, "data", "auth", appName);
}

/*
 * An app's suite store under QAYABA_ROOT/data — the qayaba-data volume, never mounted into the agents container: the accepted e2e
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
  getAgentDeps?: (turn?: TurnTelemetryContext) => AgentDeps;
}

export interface AcceptanceHarness {
  validation: ValidationPort;
  execution: ExecutionPort;
  objectiveSignal: ObjectiveSignalPort;
  review?: ReviewPort;
}

/*
 * The acceptance an experiment judges every arm by (accept-delivered-specs.use-case.ts), over the same parts the pipeline's own run uses: the
 * static gate, the Playwright runner, the change-coverage collector under the app's coverage policy (no mutation pass: it doubles a DEV
 * run and decides nothing here) and the independent reviewer. It is built over a copy of the working copy, never over a mirror.
 */
export function buildAcceptanceHarness(input: AcceptanceHarnessInput): AcceptanceHarness {
  const { app, copyDir, exec } = input;
  const e2eRelDir = "e2e";
  const baseUrl = app.dev.baseUrl;
  const env = activeEnvironment();

  const validateDeps = createValidateDeps(exec);
  const staticGate = new StaticGateAdapter({
    typecheck: validateDeps.typecheck,
    lint: validateDeps.lint,
    listTests: validateDeps.listTests,
    checkManifest: validateDeps.checkManifest,
    validateAll: (specDir) => validateSpecs(specDir, validateDeps),
    autofix: (specDir, specs) => fixLintedSpecs(specDir, specs, exec),
  });
  const validation = new ValidationPortAdapter({ e2e: staticGate });

  const e2eExecuteDeps: E2eExecuteDeps = {
    ...createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eTimeoutMs(env), exec, env.PW_ACTION_TIMEOUT_MS),
    ...(app.dev.geolocation ? { geolocation: app.dev.geolocation } : {}),
    ...(app.dev.dataState ? { dataState: app.dev.dataState } : {}),
  };
  const execution = new ExecutionPortAdapter(
    { e2e: new E2eExecutionStrategy((specDir, opts) => runE2E(specDir, opts, e2eExecuteDeps)) },
    { namespace: `${app.qa.testDataPrefix}-acceptance`, baseUrl, ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}) },
  );

  const { mode, minRatio } = resolveCoveragePolicy(app.qa.changeCoverage);
  const policy = { mode, minRatio };
  const objectiveSignal = new ObjectiveSignalPortAdapter(
    {
      collector: makeTargetCoverageCollector([]),
      decide: new DecideCoverageService(),
    },
    { policy, repoDir: copyDir, namespace: `${app.qa.testDataPrefix}-acceptance`, assembleChangeCoverage },
  );

  const getAgentDeps = input.getAgentDeps;
  /* The reviewer's steps are classified from the app's own configuration here too. */
  const acceptanceTurn: TurnTelemetryContext = {
    intent: stepIntentContextFor({ e2eRelDir, ...(baseUrl ? { baseUrl } : {}), ...(app.auth?.loginPath !== undefined ? { loginPath: app.auth.loginPath } : {}), reviewAgents: [roleToAgentName("reviewer")] }),
  };
  const review = getAgentDeps
    ? new ReviewPortAdapter(
        {
          runtime: new AgentRuntimeAdapter({ open: async (agent, cwd, opts) => getAgentDeps(acceptanceTurn).open(agent, cwd, { ...(opts?.signal ? { signal: opts.signal } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts?.timeLimit ? { timeLimit: opts.timeLimit } : {}), ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}), ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}) }) }, roleToAgentName),
          rendering: new PromptRenderingAdapter({ buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow }),
          verdicts: new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict }),
          repair: contractRepair,
        },
        { diff: "", mirrorDir: copyDir, e2eRelDir, appName: app.name, mode: "diff", baseUrl, timeoutMs: reviewerTimeoutMs() },
      )
    : undefined;

  return { validation, execution, objectiveSignal, ...(review ? { review } : {}) };
}

export function buildEngineRootDeps(
  app: AppConfig,
  deps: RunEngineFactoryDeps,
  namespace: string,
  run: { mode: RunMode; guidance?: string; triggerRepo?: string; changeSet?: ChangeSet; sha?: string; runId?: string; grounding?: GroundingInput | EffectiveConfig["grounding"]; freeze?: RunFreeze },

  observer?: ObserverPort,
): EngineRootDeps {
  /* The pre-generation context pack's live-DOM arm (an A/B lever): the resolved effective config already carries it, so this is always a boolean here. */
  const domPack = resolveDomPack(run.grounding?.domPack, app.qa.domPack);
  if (domPack === false) {
    appLogger.warn(`[qa] grounding.domPack is OFF for ${app.name}: the pre-generation context pack carries no live DOM. The review, pre-exec and post-failure DOM seams are independent and unchanged; the authenticated-browser alternative is available only when the app and tools grant it.`);
  }
  const e2eRelDir = "e2e";

  const redactionPort = new RedactionPortAdapter();

  const e2eDefaultTimeoutMs = e2eTimeoutMs(activeEnvironment());
  const pwActionTimeoutMs = activeSettings().run.pwActionTimeoutMs;

  const codeSandbox = resolveCodeSandbox(deps.env ?? activeEnvironment());

  const coveragePolicy = resolveCoveragePolicy(app.qa.changeCoverage);
  const intentLock = resolveIntentLock(app.qa.intentLock);

  const mirrorRoot = deps.mirrorRoot ?? workdirRoot();
  /*
   * Placeholder static mirrorDir — the real per-run dir is whatever checkout(sha) returns.
   * This field satisfies EngineRootDeps's static shape and seeds the coverage collector.
   * An unmeasured/mismatched repoDir reads as "unknown", which never blocks publish.
   */
  const mirrorDir = join(mirrorRoot, app.repo.replaceAll("/", "__"));
  /*
   * ONE resolver per run, shared by every session that states a limit: the generator and the reviewer
   * both run in the primary mirror (the working copy checkout(sha) returns is this same directory), so one read of it
   * answers for both. A host with no facade has no limit to give.
   */
  const runContext = deps.getAgentFacade ? new RunContextBudget() : undefined;
  const stepLimitFor = deps.getAgentFacade && runContext ? stepLimitResolver(deps.getAgentFacade, mirrorDir, runContext, () => getHistory().telemetry.getRecentTurnFigures(WORKING_ROOM_HISTORY_TURNS)) : undefined;

  /*
   * QAYABA_ROOT/data (the qayaba-data volume — NOT mounted into the agents container, only mirrors
   * is). authDir is where AuthSessionAdapter writes storageState/client.p12/cert.pass and where
   * every execute/DOM-capture spawn reads them back from: an orchestrator-only directory, never
   * the watched-repo mirror.
   */
  const root = qayabaRoot();
  const dataDir = qayabaDataDir();
  const authDir = appAuthDir(root, app.name);
  /*
   * The execution sandbox: every child that runs code an agent influenced (specs, the project's own tsc/eslint/--list and
   * installs, a login script) starts through `exec`, and each run opens its scope
   * (work dir, auth copies, egress policy) in `execScope`.
   */
  const suiteAccount = suiteAccountFor(app, deps.env ?? activeEnvironment());
  const egressGate = egressGateFor(deps.env ?? activeEnvironment(), codeSandbox);
  const execWiring = buildExecWiring({
    env: deps.env ?? activeEnvironment(),
    sandbox: codeSandbox,
    authDir,
    mirrorRoot,
    egressOrigins: resolveRunOrigins(app, loadRegistryGroups(root)),
    ...(egressGate ? { egress: egressGate } : {}),
    ...(suiteAccount ? { suiteAccount } : {}),
    ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
  });
  const exec = execWiring.exec;


  /*
   * The server froze the run (run-freeze.ts: a campaign-tagged request; qa-engine reads no environment and no request): the run starts
   * from a fixed state (the suite store read-only, the context map and the login not rebuilt, no process audit). The collaborators below
   * are left out, which the composition root reads as "not wired" (a provable no-op), never as a stub that pretends to learn.
   */
  const campaignFrozen = run.freeze?.frozen ?? false;

  const triggerService =
    run.triggerRepo && run.triggerRepo !== app.repo
      ? app.services?.find((s) => s.repo === run.triggerRepo)
      : undefined;
  if (run.triggerRepo && run.triggerRepo !== app.repo && !triggerService) {
    throw new Error(`trigger repo ${run.triggerRepo} is not a declared service of app ${app.name}`);
  }

  /* A run over several repos: the entries besides the anchor are declared services the change also reached. */
  const companionServices = (run.changeSet?.entries ?? [])
    .filter((entry) => entry !== run.changeSet!.anchor)
    .map((entry) => {
      const service = app.services?.find((s) => s.repo === entry.repo);
      if (!service) throw new Error(`change entry ${entry.repo} is not a declared service of app ${app.name}`);
      return { service, headSha: entry.headSha.toString() };
    });

  if (triggerService && run.mode === "context") {
    throw new Error(`context mode cannot be triggered by a service repo (${triggerService.repo}); run it from the primary repo ${app.repo}`);
  }

  /*
   * The process-audit's context_stale flag (markContextStale, in processAudit's invalidateContext
   * below): a run that sees it skips the known-bad stored/disk map and requests a rebuild at its
   * own sha. Only a primary-repo run that is not itself the rebuild qualifies: `run.mode !== "context"` (a context-mode run IS the rebuild) and
   * `!triggerService` (a service-triggered run's sha belongs to the service repo, not the primary).
   */
  const contextHeal = new RequestContextHeal(deps.enqueueContextRun, { clear: (app) => getHistory().contexts.clearContextStale(app) });
  const flagHeal = staleFlagHeal({ mode: run.mode, triggeredByService: triggerService !== undefined, frozen: campaignFrozen }, () => getHistory().contexts.isContextStale(app.name));
  const contextStale = flagHeal !== "none";
  if (flagHeal === "withhold") {
    /* A campaign's queue holds only its own runs: the rebuild is left for after it, and the flag stays as the campaign found it. */
    appLogger.info(`[qa] context map for ${app.name} was marked stale by the process audit — skipping the stored/disk map this run; the campaign freeze requests no rebuild.`);
  } else if (flagHeal === "request") {
    appLogger.info(`[qa] context map for ${app.name} was marked stale by the process audit — skipping the stored/disk map this run and requesting a rebuild.`);
    contextHeal.execute(app.name, run.sha, run.runId);
  }

  /* Where the map the run actually used came from, and how fresh it was (observe-only). */
  let mapProvenance: ContextProvenance | undefined;
  /* An off-path rebuild for a map stale by SHA/age, asked once per app and commit, never by a context run (it is the rebuild).
   * The process-audit flag keeps its own path above; this one never clears that flag. */
  const requestMapHealIfDue = (): void => {
    const key = `${app.name}@${run.sha ?? ""}`;
    const heal = staleMapHeal({ mode: run.mode, frozen: campaignFrozen }, mapProvenance, contextHealRequested.has(key));
    if (heal === "none" || !mapProvenance) return;
    if (heal === "withhold") {
      mapProvenance = { ...mapProvenance, recapture: "skipped" };
      return;
    }
    contextHealRequested.add(key);
    getHistory().contexts.recordContextHealRequest(app.name);
    mapProvenance = { ...mapProvenance, recapture: "requested" };
    contextHeal.execute(app.name, run.sha, run.runId);
  };

  /* Whether a map built at `capturedSha` describes this run's commit, and the map the run receives if it does (context-map-fit.ts). */
  const changesBetween = deps.contextMapChanges ?? gitChangedFiles;
  const mapFitsRun = (map: ArchitectureContext, capturedSha: string) =>
    contextMapFitsRun(map, capturedSha, { sha: run.sha, triggeredByService: triggerService !== undefined }, (fromSha, toSha) => changesBetween(mirrorDir, fromSha, toSha));

  /*
   * deps.mirror is a test seam only. Production checkout always uses defaultMirrorDeps
   * (workdirRoot()). deps.mirrorRoot overrides the path, not the git collaborator.
   */
  const mirror = deps.mirror ?? { ensureMirror, ensureMirrorAtBranch };
  /* Defaults to the real stageServiceContext in production. */
  const stage = deps.stageServiceContext ?? ((input: StageServiceContextInput) => stageServiceContext(input, defaultStageDeps));


  const branch = namespace;

  const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });
  const loginRunner = createExecBinaryRunner({ exec, profile: "login", commandClass: "login", processKill: new ProcessKillAdapter() });
  /*
   * Cross-repo composition (bug fix): the diff/classify SOURCE is the SERVICE mirror at the event
   * sha for a cross-repo run — never the primary. Same dir formula as mirrorDir above
   * (mirrorRoot + repo.replaceAll("/", "__")), reused verbatim so this can never silently diverge
   * from where ensureMirror actually writes (the SAME rationale mirrorDir's own comment gives).
   */
  const vcsDir = triggerService ? join(mirrorRoot, triggerService.repo.replaceAll("/", "__")) : mirrorDir;
  const vcs = new GitMirrorReadAdapter(vcsDir, runner);
  /* Each entry of a run over several repos is read from its own mirror; the anchor's is the reader above. */
  const vcsFor = companionServices.length > 0
    ? (repo: string): VcsReadPort => (repo === (triggerService?.repo ?? app.repo) ? vcs : new GitMirrorReadAdapter(join(mirrorRoot, repo.replaceAll("/", "__")), runner))
    : undefined;
  /* How the commit a repo's version source reports relates to the run's sha: read in that repo's mirror, brought up to date first so a commit that landed after the last run is in it. */
  const mirrorAncestry = (repo: string): CommitAncestryPort => ({
    relation: async (served, head) => new GitMirrorReadAdapter(await mirror.ensureMirror(repo, head.value, defaultMirrorDeps), runner).relation(served, head),
  });
  /* Cross-repo: the source is the SERVICE's, never the primary's; no source declared anywhere means no gate to wire. */
  const gateVersionUrl = triggerService ? triggerService.versionUrl : app.dev.versionUrl;
  /* The service's deploy is slower than the primary's, so its gate polls and waits on its own defaults. */
  const deployGate = triggerService ? deployGateTiming(triggerService, "service") : deployGateTiming(app.dev, "app");


  const grounding = run.grounding;
  /* The run's code graph (one instance: the index phase builds it, the structural signal and the cross-repo impact read it). */
  const codeGraph = codeGraphFor({ exec, git: runner, dataDir, sandbox: codeSandbox, processKill: new ProcessKillAdapter() })(app.name, app.qa.structuralSignals?.exclude ?? []);
  const serviceTopologyOn = grounding?.stitcher === false || grounding?.stitcher === "off" ? false : serviceTopologyWired(app);

  /* What classifies this run's agent steps in its trace: the app's own configuration, never a name. */
  const turnTelemetry: TurnTelemetryContext = {
    intent: stepIntentContextFor({
      e2eRelDir,
      baseUrl: app.dev.baseUrl,
      ...(app.auth?.loginPath !== undefined ? { loginPath: app.auth.loginPath } : {}),
      reviewAgents: [roleToAgentName("reviewer")],
    }),
  };
  /* Reuse the host AgentDeps. Forward descriptor so session registration sees the real runId. */
  const runtimeAdapter = new AgentRuntimeAdapter(
    {
      open: async (agent, cwd, opts) => {
        const real = deps.getAgentDeps(turnTelemetry);
        return real.open(agent, cwd, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.timeLimit ? { timeLimit: opts.timeLimit } : {}),
          ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
          ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
        });
      },
    },
    roleToAgentName,
  );
  /*
   * The run-level wall-clock deadline: one per run (this factory builds the engine for one run), armed by the use case
   * after classification and read by every agent turn of the run through the bounded runtime below, so no turn (a
   * regeneration, a fix-loop round, a repair, the coverage regen, the reviewer, a sidekick) outlives it.
   * QA_RUN_TIME_BUDGET_MS_* override a kind of run's time; read here once because qa-engine reads no environment. A
   * mistyped value throws.
   */
  const runDeadline = new RunDeadline({ now: deps.now ?? Date.now, budgets: resolveRunTimeBudgets(deps.env ?? activeEnvironment()) });
  const boundedRuntime = new RunDeadlineRuntime(runtimeAdapter, runDeadline, { hostPromptCapMs: agentPromptCapMs() });
  /* Run-level round per role: numbers each role's generated turns across sessions, so a regeneration's turn reads round 1, not the transport's session-local 0. */
  const roundRuntime = new RunRoundRuntime(boundedRuntime);
  const rendering = new PromptRenderingAdapter({ buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow }, runContext?.budget);
  const verdicts = new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });

  const generationUseCase = new GenerateTestsUseCase({
    runtime: roundRuntime,
    rendering,
    verdicts,
    manifest: new ManifestRepositoryAdapter({ readManifest, reconcileManifest }),
    repair: contractRepair,
  });


  const plainValidateDeps = createValidateDeps(exec);
  /* Each static check is a span of its own under the validate phase (telemetry off: the checks as they are). */
  const validateDeps = deps.telemetry ? traceValidateDeps(plainValidateDeps, deps.telemetry) : plainValidateDeps;
  const staticGate = new StaticGateAdapter({
    typecheck: validateDeps.typecheck,
    lint: validateDeps.lint,
    listTests: validateDeps.listTests,
    checkManifest: validateDeps.checkManifest,
    validateAll: (specDir) => validateSpecs(specDir, validateDeps),
    autofix: (specDir, specs) => fixLintedSpecs(specDir, specs, exec),
  });


  const e2eExecuteDeps: E2eExecuteDeps = {
    ...createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eDefaultTimeoutMs, exec, pwActionTimeoutMs, undefined, undefined, undefined, deps.telemetry),
    ...(app.dev.geolocation ? { geolocation: app.dev.geolocation } : {}),
    ...(app.dev.dataState ? { dataState: app.dev.dataState } : {}),
    /* The Playwright report as spans (spec files, cases, attempts) under the phase that executes. */
    ...(deps.telemetry ? { onReport: (report, cases) => synthesizeReportSpans({ telemetry: deps.telemetry! }, report, cases) } : {}),
  };
  const e2eCleanupDeps = createDefaultE2eCleanupDeps(new ProcessKillAdapter(), exec);
  /* One launcher-backed DOM capture for every grounding seam (Context Pack, review DOM, pre-exec). */
  const captureDomDeps = createCaptureDomDeps(exec, undefined, deps.telemetry ? domCaptureObserver(deps.telemetry) : undefined, app.dev.geolocation, app.dev.dataState);
  const e2e = new E2eExecutionStrategy((specDir, opts) => runE2E(specDir, opts, e2eExecuteDeps));

  /*
   * changedFiles starts as [] — no per-run diff exists at composition time. measure() derives the
   * real list from the dynamic diff. repoDir/e2eDir stay primary-bound: browser coverage cannot map
   * service-repo lines, so cross-repo coverage is "unknown" (never blocks publish).
   */
  const collector = makeTargetCoverageCollector([]);

  /*
   * The mutation pass: unless `qa.changeCoverage.bundleMutation` is off, an app re-runs, for each of a few mutants of the changed code in the served
   * script, the spec files that reached it, once (no retry: a mutant that fails a test once was noticed).
   */
  const mutation = bundleMutationEnabled(app.qa.changeCoverage)
    ? new BundleMutationOracleAdapter(
        ({ dir, baseUrl, namespace, mutant, specFiles, observe }) => runE2E(dir, { baseUrl, namespace, specFiles, retries: 0, ...(mutant !== undefined ? { mutant } : {}), ...(observe ? { observe: true } : {}) }, e2eExecuteDeps),
        countInjectedResponses,
        app.dev.baseUrl,
      )
    : undefined;

  /*
   * checkout(sha) resolves the real per-run mirrorDir and stages every declared sibling service's
   * READ-ONLY context into it (MultiRepoCheckoutAdapter, qa-engine-resident). Mirror ops are
   * curried here so the adapter never needs to know about MirrorDeps (a src/-only type) —
   * production always threads the module's own defaultMirrorDeps.
   */
  const multiRepoCheckout = new MultiRepoCheckoutAdapter(
    {
      primaryRepo: app.repo,
      baseBranch: baseBranchOf(app),
      services: app.services ?? [],
      ...(triggerService ? { triggerService: { repo: triggerService.repo, ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) } } : {}),
      ...(companionServices.length > 0 ? { changedServices: companionServices.map((c) => ({ repo: c.service.repo, headSha: c.headSha })) } : {}),
    },
    {
      ensureMirror: (repo, sha) => mirror.ensureMirror(repo, sha, defaultMirrorDeps),
      ensureMirrorAtBranch: (repo, branch) => mirror.ensureMirrorAtBranch(repo, branch, defaultMirrorDeps),
      stageServiceContext: (input) => stage(input),
    },
  );
  const checkout = (checkoutSha: Sha): Promise<string> => multiRepoCheckout.checkout(checkoutSha);


  const setupAdapter = buildSetupAdapter(exec, codeSandbox);

  return {
    repo: app.repo,
    appName: app.name,
    mirrorDir,
    e2eRelDir,
    branch,
    mode: run.mode,
    ...(run.guidance ? { guidance: run.guidance } : {}),
    needsReview: app.qa.needsReview,
    shadow: app.qa.shadow ?? false,
    onFailure: app.report.onFailure,
    maxRetries: fixLoopMaxRetries(app.qa.fixLoop),
    domPack,
    /* The route table at the run's base, for the availability classification: read through the confined mirror reader. */
    readFileAtRef: (ref: string, file: string) => vcs.fileAt(ref, file),
    /* A context-mode run's prompt discards the pack; building it would spend the live-DOM capture for nothing. */
    contextPack: run.mode !== "context",
    /*
     * Multi-agent coordination is always wired. Fail-open paths inside RunQaUseCase are the
     * safety net; telemetry lands in the durable JSONL sink. Distinct from qa.shadow
     * (PR/Issue publishing). Default path matches HISTORY_DB_PATH's data/ root;
     * COORDINATION_TELEMETRY_PATH overrides (e.g. a mounted volume).
     */
    coordinationTelemetryPath: resolveCoordinationTelemetryPath(),
    /*
     * Per-delegation wall-clock cap — env-tunable here (the shell), never read by qa-engine's
     * engine-root itself. Absent → engine-root's own hardcoded default (420_000).
     */
    /*
     * The same coveragePolicy that configures the objective signal (computed once, above), so
     * the policy that measures coverage and the one that decides whether it blocks never diverge.
     */
    coveragePolicyMode: coveragePolicy.mode,
    coverageMinRatio: coveragePolicy.minRatio,
    coverageBranchCases: coveragePolicy.branchCases,
    /* The same intentLock that configures the contract check, so the derived policy has one source. */
    intentLock,
    ...(app.qa.iterationBudget !== undefined ? { iterationBudget: app.qa.iterationBudget } : {}),
    /* Read when the run is wired, from the live runtime assignment: the runtime is switchable. */
    ...(deps.getAgentFacade ? { reviewerIndependence: () => reviewerIndependence(deps.getAgentFacade!().config) } : {}),

    diff: "",

    vcs,
    ...(vcsFor ? { vcsFor } : {}),
    generationUseCase,
    ...(stepLimitFor ? { stepLimitFor } : {}),
    ...(runContext ? { contextBudget: runContext.budget } : {}),
    runDeadline,
    phaseHistory: historyPhaseHistory((appName, budget, limit) => getHistory().runs.recentPhaseRecords(appName, budget, limit)),
    ...(deps.telemetry ? { telemetry: deps.telemetry, toolAttempts: agentTurnTraces } : {}),
    /* What a run's specs held at validation is kept for after-the-fact grading, as long as the run is traced. */
    ...(deps.telemetry ? { specSnapshots: new SqliteSpecSnapshotAdapter(), planSnapshots: new SqlitePlanSnapshotAdapter() } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    reviewRuntime: {
      runtime: roundRuntime,
      rendering,
      verdicts,
      repair: contractRepair,
    },
    reviewTimeoutMs: reviewerTimeoutMs(),
    validationStrategies: { e2e: staticGate },
    executionStrategies: { e2e },

    setupCollaborators: {
      e2e: (specDir, opts) => setupAdapter.setup(specDir, opts),
    },

    cleanupCollaborators: {
      e2e: (args) => e2eCleanupDeps.runCleanup(args),
    },

    /*
     * contextPackDeps.domDeps is ALWAYS overridden so the
     * pre-generation DOM capture reads auth material from the orchestrator-only authDir, never
     * from the mirror — the qa-engine default (defaultCaptureDomDeps) would
     * otherwise derive credential paths from e2eDir itself.
     */
    groundingCollaborators: {
      contextPackDeps: { ...defaultContextPackDeps, domDeps: captureDomDeps, ...(app.dev.routeSamples ? { routeSamples: app.dev.routeSamples } : {}) },
      /*
       * The DB (the context_maps table) is the engine's source of truth for the
       * FE<->BE architecture map — it survives regardless of shadow. The repo file on disk is only a
       * fallback (e.g. before any context run has ever completed for this app, or a fresh clone).
       * A `contextStale` flag seen above means the process audit already judged the stored (and
       * any repo-file) map wrong — this run grounds without it; the rebuild requested above (or a
       * manual context run) replaces the map for later runs.
       */
      loadContextMap: (specDir: string) => {
        if (contextStale) {
          mapProvenance = {
            location: "db:context_maps",
            stale: true,
            staleReason: "marked-stale",
            recapture: campaignFrozen ? "skipped" : "requested",
          };
          return undefined;
        }
        const stored = getHistory().contexts.loadContextMap(app.name);
        if (stored) {
          const capturedMs = Date.parse(stored.updatedAt);
          const ageMs = Number.isFinite(capturedMs) ? Math.max(0, Date.now() - capturedMs) : undefined;
          const fit = mapFitsRun(stored.data, stored.builtAtSha);
          const staleByAge = ageMs !== undefined && ageMs > CONTEXT_MAP_MAX_AGE_MS;
          const stale = !fit.fits || staleByAge;
          mapProvenance = {
            location: "db:context_maps",
            capturedAt: stored.updatedAt,
            capturedSha: stored.builtAtSha,
            ...(ageMs !== undefined ? { ageMs } : {}),
            resultCount: contextMapResultCount(stored.data),
            stale,
            staleReason: !fit.fits ? fit.reason : staleByAge ? "older-than-max-age" : "none",
            recapture: "not-needed",
          };
          if (stale) requestMapHealIfDue();
          return fit.map;
        }
        const disk = loadContextMapFromDisk(specDir);
        if (disk) {
          const fit = mapFitsRun(disk, disk.builtAtSha);
          mapProvenance = {
            location: "file:e2e/.qa/context.json",
            capturedSha: disk.builtAtSha,
            resultCount: contextMapResultCount(disk),
            stale: !fit.fits,
            staleReason: fit.fits ? "none" : fit.reason,
            recapture: "not-needed",
          };
          if (!fit.fits) requestMapHealIfDue();
          return fit.map;
        }
        return disk;
      },
    },
    contextMapProvenance: () => mapProvenance,
    reviewDomGroundingCollaborators: { captureDomDeps },
    preExecGroundingCollaborators: { captureDomDeps },
    /*
     * Classify-source repo root: SERVICE mirror on a webhook, PRIMARY otherwise. Indexing and
     * the structural-signal adapter must pin this dir — workspace.mirrorDir is the suite (primary)
     * even on a cross-repo run, so using it would stamp the service SHA onto the frontend graph.
     */
    codeGraphRepoDir: vcsDir,

    codeGraph,
    codeExplore: codeGraph,
    coChange: new GitCoChangeAdapter(runner),
    /* A service-triggered run indexes the primary repo too, at the commit it is checked out at. */
    /* The repos the lead's code-graph tool answers over: the classify-source repo, then every other entry of the change. */
    ...(companionServices.length > 0
      ? { codeGraphRepos: [{ repo: triggerService?.repo ?? app.repo, repoDir: vcsDir }, ...companionServices.map((c) => ({ repo: c.service.repo, repoDir: join(mirrorRoot, c.service.repo.replaceAll("/", "__")) }))] }
      : {}),
    /* Each other service of a run over several repos is indexed at its head too. */
    ...(companionServices.length > 0 ? { codeGraphRepoDirs: new Map(companionServices.map((c) => [c.service.repo, join(mirrorRoot, c.service.repo.replaceAll("/", "__"))])) } : {}),
    /* Every declared service has a mirror a cross-repo hop may index on demand; only an app with a declared boundary has links to hop along. */
    ...(serviceTopologyOn && app.services?.length
      ? {
          codeGraphMirrors: new Map(
            app.services.map((s) => {
              const repoDir = join(mirrorRoot, s.repo.replaceAll("/", "__"));
              return [s.repo, { repoDir, headSha: () => new GitMirrorReadAdapter(repoDir, runner).headSha() }] as const;
            }),
          ),
        }
      : {}),
    ...(triggerService ? { codeGraphPrimary: { repo: app.repo, repoDir: mirrorDir, headSha: () => new GitMirrorReadAdapter(mirrorDir, runner).headSha() } } : {}),
    /* The lead's code-graph tools' client. */

    ...(serviceTopologyOn && app.services
      ? {
          serviceTopology: {
            appName: app.name,
            primaryRepo: app.repo,
            mirrorRoot,  /* the SAME local already computed above (deps.mirrorRoot ?? workdirRoot()) */
            services: app.services.map((s) => ({ repo: s.repo })),
            boundaryProfiles: new YamlBoundaryProfileAdapter((name) =>
              expandEnv(readFileSync(join(qayabaRoot(), "config", "apps", `${name}.yaml`), "utf8"), activeEnvironment())),
          },
        }
      : {}),

    ...(serviceTopologyOn
      ? { crossRepoImpact: { mirrorRoot, runner } }
      : {}),

    execScope: execWiring.execScope,
    /* How this app's runs are coordinated: its qa.coordination with every limit it left out defaulted. */
    coordinationSettings: resolveCoordinationSettings(app.qa.coordination),
    /*
     * The lead/sidekick mode: the workspaces of a run's sidekicks lie beside the mirrors, on the volume the agents' runtime can open
     * a session in; the runtime of the sidekick role is read as it is now (it is switchable), and a host that cannot say is not
     * assumed to be OpenCode: only OpenCode can call run_spec and the authenticated browser.
     */
    delegation: {
      workspaceRoot: join(mirrorRoot, DELEGATIONS_DIR),
      deadline: runDeadline,
    },
    /*
     * The run_spec loop: composed for an e2e app whenever the host has a registry; whether a run is granted it is the app's
     * qa.closedLoop (or the run's own choice), decided when the run opens it. The generator's role is read from the agent
     * facade as it is now (the runtime is switchable): only OpenCode can call a custom tool, and a host that cannot say is
     * not assumed to be. The account lock is the process's, since the key is the app's login and the processes share nothing else.
     */
    ...(deps.closedLoopRegistry
      ? {
          closedLoop: {
            registry: deps.closedLoopRegistry,
            setting: {
              enabled: closedLoopEnabled(app),
              limits: closedLoopLimitsOf(app.qa.closedLoop),
            },
            generatorRuntimeCanCall: () => (deps.getAgentFacade ? assignmentForRole(deps.getAgentFacade().config, "author").provider === "opencode" : false),
            account: `${app.name}/${app.auth?.usernameEnv ?? "public"}`,
            lock: PROCESS_ACCOUNT_LOCK,
            deadline: runDeadline,
            redact: (text: string) => redactionPort.redact(redactByValue(text)),
          },
        }
      : {}),
    /*
     * The authenticated agent browser: composed for an e2e app with a DEV url whenever the host has a registry; whether a run is
     * granted it is the app's qa.agentBrowser (or the run's own choice), decided when the run opens it. It starts in the execution
     * sandbox (the same launcher, uid and egress lease a spec gets) with a lifetime of its own on Linux, so that a browser the
     * orchestrator forgot, because it was restarted in place, ends by itself. The generator's runtime is read as it is now, and a
     * host that cannot say is not assumed to be OpenCode: only OpenCode can call a custom tool.
     */
    /*
     * The lead's code-graph tool: a read-only explore of the index the index phase built, served by the orchestrator, whose engine
     * and store the agents container never holds. Only where the structural signal has the code graph, and only for a lead on
     * OpenCode.
     */
    ...(deps.codeGraphRegistry
      ? {
          codeGraphTools: {
            registry: deps.codeGraphRegistry,
            generatorRuntimeCanCall: () => (deps.getAgentFacade ? assignmentForRole(deps.getAgentFacade().config, "author").provider === "opencode" : false),
            redact: redactSourceForModel,
          },
        }
      : {}),
    ...(deps.agentBrowserRegistry
      ? {
          agentBrowser: {
            registry: deps.agentBrowserRegistry,
            setting: {
              enabled: agentBrowserEnabled(app),
              denyRoutes: app.qa.agentBrowser?.denyRoutes ?? [],
              allowMutating: app.qa.agentBrowser?.allowMutating ?? [],
            },
            generatorRuntimeCanCall: () => (deps.getAgentFacade ? assignmentForRole(deps.getAgentFacade().config, "author").provider === "opencode" : false),
            createHost: (parts) => new PlaywrightAgentBrowserHost(parts),
            launcher: new SandboxedChromiumLauncher({
              exec: execWiring.exec,
              chromium: loadPlaywrightChromium,
              kill: new ProcessKillAdapter(),
              ...(process.platform === "linux" ? { ttlWrapper: { command: "timeout", seconds: AGENT_BROWSER_LIFETIME_SECONDS } } : {}),
            }),
            account: `${app.name}/${app.auth?.usernameEnv ?? "public"}`,
            lock: PROCESS_ACCOUNT_LOCK,
            ...(app.auth?.loginPath !== undefined ? { loginPath: app.auth.loginPath } : {}),
            deadline: runDeadline,
            redact: (text: string) => redactionPort.redact(redactByValue(text)),
          },
        }
      : {}),
    /*
     * The authoring location: the app's declared position (dev.geolocation) and the places it names. The suite and the Context
     * Pack already get the position through the execution deps; this is the run-scoped value the agent may move for the
     * authenticated browser and the plan's flows.
     */
    ...(deps.geolocationRegistry && app.dev.geolocation
      ? {
          geolocation: {
            registry: deps.geolocationRegistry,
            setting: {
              default: { latitude: app.dev.geolocation.latitude, longitude: app.dev.geolocation.longitude },
              places: app.dev.geolocation.places ?? {},
            },
          },
        }
      : {}),
    baseUrl: app.dev.baseUrl,
    authSession: {
      env: activeEnvironment(),
      authDir,
      ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
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
      /* The hosts the app leaves blocked on purpose (dev.blockedOrigins) are no evidence that a failed login was the filter's doing. */
      intentionallyBlocked: blockedHostMatcher(app),
      /* The login child is the one process that carries the account: the launcher's `login` profile. It writes the session in the run's own `login` folder, and the adapter brings a confirmed one into the auth directory. */
      loginStaging: () => ({ dir: join(exec.workDir(), "login"), root: exec.workDir() }),
      spawnSetup: async (specDir: string, env: Record<string, string>, signal?: AbortSignal) => {
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
    },
    ...(app.auth ? { auth: app.auth } : {}),
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
    objectiveSignal: { collector, ...(mutation ? { mutation } : {}) },
    coveragePolicy,
    /* Change-coverage: unknown never blocks publish. */
    assembleChangeCoverage,
    baselineCases: [],


    githubPr: new GitHubPrAdapter(githubHttpDeps(), baseBranchOf(app)),
    githubIssue: new GitHubIssueAdapter(githubHttpDeps()),
    /* Stage/commit/push generated tests before opening the PR. */
    publish: publishWiring(run.mode),

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
    versionUrl: gateVersionUrl,
    ...(gateVersionUrl ? { versionAncestry: mirrorAncestry(triggerService?.repo ?? app.repo) } : {}),
    deployGateIntervalMs: deployGate.intervalMs,
    deployGateTimeoutMs: deployGate.timeoutMs,
    ...(companionServices.length > 0
      ? {
          companionDeployGates: companionServices.map(({ service }) => ({
            repo: service.repo,
            ...(service.versionUrl ? { versionUrl: service.versionUrl } : {}),
            ancestry: mirrorAncestry(service.repo),
            ...deployGateTiming(service, "service"),
          })),
        }
      : {}),


    ...(deps.historyFilePath ? { historyFilePath: deps.historyFilePath } : { runHistory: new SqliteRunHistoryAdapter() }),

    /* Every run records what it read of DEV, frozen or not: the rows are facts about DEV and writing them changes nothing the run does. */
    lessonStore: new SqliteLessonStoreAdapter(),
    /* Only the run whose lessons lever is on is told what earlier observations teach (decideRunFreeze). */
    readLessons: run.freeze?.lessons ?? true,
    ...(campaignFrozen ? {} : { processAudit: new ProcessAuditPortAdapter({
      app: app.name,
      readRecentOutcomes: (a, limit) => getHistory().learning.listRunOutcomes(a, limit),
      invalidateContext: (reason) => {
        try {
          getHistory().contexts.markContextStale(app.name);
          appLogger.info(`[audit] marked context stale for ${app.name} — rebuilds next run (${reason})`);
          return true;
        } catch {
          return false; 
        }
      },
    }) }),
    /*
     * ContextMapCapturePort — write side of the FE<->BE architecture map. Constructed here for the
     * same reason processAudit is: its store is the history repositories (src-only; qa-engine may never import
     * it). Wired unconditionally: a clean context-mode pass is the only run that ever invokes it.
     * Storing a fresh map disarms the process audit's stale flag, whoever started the context run
     * (a heal, a manual or onboarding run, the server or the CLI). Only a map the run wrote is
     * fresh: a committed map left untouched is neither stored nor disarms the flag.
     */
    contextMapCapture: new ContextMapCapturePortAdapter(storeFreshContextMap, contextMapWrittenThisRun),
    /*
     * The accepted e2e suite of this app, in the qayaba-data volume (never mounted into the agents container). A checkout wipes every
     * untracked file of the mirror, and shadow mode never publishes: without the store every run would start cold, re-seed the
     * stock login and ask the agent to author it again.
     * Under the freeze the store is read-only: the suite is cross-run state like the learning the freeze already withholds,
     * and a campaign seeds the store itself (scripts/warm-suite.ts seed-store) before each arm-run.
     */
    suiteStore: new SuiteStoreAdapter({ storeDir: appSuiteStoreDir(root, app.name), app: app.name, repo: app.repo, specRelDir: e2eRelDir, seedDir: join(qayabaRoot(), "config", "e2e"), listTracked: gitListTracked(runner), now: () => new Date(), readOnly: campaignFrozen }),
    ...(observer ? { observer } : {}),
  };
}


/* What the composition tells the agent transport about a run, for its trace: how the app's steps are classified. */
export interface TurnTelemetryContext {
  intent: StepIntentContext;
}

/* The classification of a host that was handed none: an e2e suite in `e2e/`, no login of its own, no judging agent. */
const DEFAULT_STEP_INTENT: StepIntentContext = { specTargets: { kind: "dir", relDir: "e2e" }, authFiles: [], loginUrls: [], authOnlyOrigins: [], reviewAgents: [] };

/* The agent transport the engine opens its sessions through: the host's, with live observation, the stall watchdog and usage, and the run_spec and agent-browser registries told which sessions the agents open for which run. */
export function engineAgentDeps(deps: Pick<RunEngineFactoryDeps, "getAgentDeps" | "closedLoopRegistry" | "agentBrowserRegistry" | "geolocationRegistry" | "codeGraphRegistry" | "telemetry" | "clock">, turn?: TurnTelemetryContext): AgentDeps {
  const registry = deps.closedLoopRegistry;
  const browsers = deps.agentBrowserRegistry;
  const geolocations = deps.geolocationRegistry;
  const codeGraphs = deps.codeGraphRegistry;
  const stack = withUsageSink(
    withStallWatchdog(
      withSessionRegistration(deps.getAgentDeps(), {
        register: registerRunSession,
        unregister: unregisterRunSession,
        bind: (session) => {
          registry?.bindSession(session);
          browsers?.bindSession(session);
          geolocations?.bindSession(session);
          codeGraphs?.bindSession(session);
          setSessionToolDeny(session.sessionId, session.denyTools);
        },
        unbind: (sessionId) => {
          registry?.unbindSession(sessionId);
          browsers?.unbindSession(sessionId);
          geolocations?.unbindSession(sessionId);
          codeGraphs?.unbindSession(sessionId);
          setSessionToolDeny(sessionId, undefined);
        },
      }),
      { stallMs: stallMs(), onStall: (sessionId) => agentTurnTraces.fired(sessionId, "stall") },
    ),
  );
  /* The turn span sits outside the stall watchdog, so it sees a watchdog's abort. Without a telemetry port the stack is returned as it is. */
  if (!deps.telemetry) return stack;
  const traced = withTurnTelemetry(stack, {
    telemetry: deps.telemetry,
    clock: deps.clock ?? SYSTEM_CLOCK,
    intent: turn?.intent ?? DEFAULT_STEP_INTENT,
    watchHost: (span) => watchSpanForHost(span),
    stepLimitFor: (agent) => maxStepsFromConfig(agent),
    agentConfig: (agent) => agentConfigFacts(agent),
  });
  /* The turn's prompt and output bodies go to Loki beside its trace, only for a run that asked for full capture (src/telemetry/prompt-body-logs.ts). */
  return withPromptBodies(traced, { staticHash: staticPromptDigest, traces: agentTurnTraces });
}

let staticDigest: string | null | undefined;
/* The digest of the static prompt layers, read once: they are files of the image. */
function staticPromptDigest(): string | null {
  if (staticDigest === undefined) staticDigest = hashStaticPrompts(qayabaRoot());
  return staticDigest;
}

export function createRunEngineFactory(
  deps: RunEngineFactoryDeps,
): (appConfig: AppConfig, namespace: string, run: { mode: RunMode; guidance?: string; triggerRepo?: string; changeSet?: ChangeSet; sha?: string; runId?: string; grounding?: GroundingInput | EffectiveConfig["grounding"] }, observer?: ObserverPort, previousNamespace?: string) => RunPipelinePort {
  const wrappedDeps: RunEngineFactoryDeps = {
    ...deps,
    getAgentDeps: (turn) => engineAgentDeps(deps, turn),
  };
  return (appConfig: AppConfig, namespace: string, run: { mode: RunMode; guidance?: string; triggerRepo?: string; changeSet?: ChangeSet; sha?: string; runId?: string; grounding?: GroundingInput | EffectiveConfig["grounding"] }, observer?: ObserverPort): RunPipelinePort => {
    const cfg = buildEngineRootDeps(appConfig, wrappedDeps, namespace, run, observer);
    return buildEngine(cfg);
  };
}
