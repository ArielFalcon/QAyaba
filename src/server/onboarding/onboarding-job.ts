
import type { OnboardingService, OnboardingRoundProgress } from "@contexts/service-topology/application/onboarding-service.ts";
import type { ProfileProposerPort, ResolveLinksResult } from "@contexts/service-topology/application/ports/index.ts";
import type { BoundaryProfile, RepoRef } from "@contexts/service-topology/domain/index.ts";
import { serializeBoundary, spliceBoundariesBlock } from "./write-boundaries";
import { aggregateResolution, type ResolutionSummary } from "./resolution-summary";
import { RedactionPortAdapter } from "../../orchestrator/sanitizer";
import { logJson } from "../../integrations/logger";


const redactionPort = new RedactionPortAdapter();

/** Onboarding job states. */
export const ONBOARD_STATE = {
  idle: "idle",
  resolvingMirrors: "resolvingMirrors",
  proposing: "proposing",
  scoring: "scoring",
  
  indexing: "indexing",
  /*
   * Post-confirm (and no-profile) architecture-map phase. NOT terminal and does NOT hold `busy`
   * (holding it would park the context run on isOnboardingActive). propose() still rejects.
   */
  mapping: "mapping",
  done: "done",
  failed: "failed",
} as const;

export type OnboardState = (typeof ONBOARD_STATE)[keyof typeof ONBOARD_STATE];

/** Onboarding job states. */
export const REPO_INDEX_STATUS = {
  ok: "ok",
  failed: "failed",
} as const;

export type RepoIndexStatus = (typeof REPO_INDEX_STATUS)[keyof typeof REPO_INDEX_STATUS];

/** One per-repo advisory-index outcome. Field-for-field with RepoIndexOutcomeSchema. */
export interface RepoIndexOutcome {
  repo: string;
  status: RepoIndexStatus;
  nodeCount?: number;
  error?: string;
}

export const ONBOARD_OUTCOME = {
  winner: "winner",
  noProfile: "no-profile",
} as const;

export type OnboardOutcome = (typeof ONBOARD_OUTCOME)[keyof typeof ONBOARD_OUTCOME];

/** Polled status DTO. The zod schema in src/contract/commands.ts mirrors it field-for-field. */
export interface OnboardingJobStatus {
  state: OnboardState;
  app?: string;
  round: number;
  ceiling: number;
  candidatesScored: number;
  lastResolvedScore?: number;
  resolvedProfile?: BoundaryProfile;
  /** Winning run's front→service edge summary. Absent for noProfile runs and jobs without resolveLinks. */
  resolution?: ResolutionSummary;
  outcome?: OnboardOutcome;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Per-repo advisory-index progress, populated once post-confirm indexing starts.
   *  Absent when the job has no indexRepo dep, and absent before indexing starts. */
  indexProgress?: RepoIndexOutcome[];
  /** Architecture-map run progress, populated once the mapping phase starts. Absent when the job
   *  has no enqueueContextRun dep or the app is code-mode. */
  mappingProgress?: MappingProgress;
}

export interface MappingProgress {
  runId?: string;
  step?: string;
  verdict?: string;
}

export interface ContextMapRunRequest {
  app: string;
  mirrorDir: string;
}

export interface ContextMapRunSnapshot {
  runId: string;
  status: "enqueued" | "running" | "done";
  step?: string;
  verdict?: string;
}

export interface ProposeBoundariesRequest {
  app: string;
  repo: string;
  services: string[];
  baseBranch?: string;
}

export type ProposeResult = { ok: true } | { ok: false; error: string };
export type ConfirmResult = { ok: true } | { ok: false; error: string };

/** Every side-effecting collaborator the job needs, injected so the state machine is unit-tested
 *  with fakes (DI shape mirrors AppAdminDeps / maintainer-runtime.ts's MaintainerConfig). */
export interface OnboardingJobDeps {
  /** True when the shared QA run queue is active — onboarding must never provision mirrors while the runner is busy. */
  isRunnerBusy(): boolean;
  /** Provisions (or refreshes) one repo's mirror at its base branch HEAD, returning the mirror dir.
   *  Production: repo-mirror.ts's ensureMirrorAtBranch + MirrorRegistryAdapter composition. */
  ensureMirrorAtBranch(repo: string, baseBranch: string): Promise<string>;
  /** Env-guard part 1: OPENCODE_API_KEY presence. */
  hasOpencodeApiKey(): boolean;
  /** Env-guard part 2: the qa-proposer agent is configured on the target opencode server. */
  hasProposerAgent(): Promise<boolean>;
  /** Composes the LLM proposer adapter for this run; ctx.signal is the job AbortSignal. */
  buildProposer(ctx: { app: string; signal: AbortSignal }): ProfileProposerPort;
  /** Composes the REAL OnboardingService (qa-engine, imported, never reimplemented) wired with the
   *  onRound observer that feeds this job's live status. */
  buildOnboardingService(proposer: ProfileProposerPort, onRound: (p: OnboardingRoundProgress) => void): OnboardingService;
  /** OPTIONAL: resolve a winning profile's cross-repo links for the status edge summary.
   *  A job without it omits `resolution`. */
  resolveLinks?(profile: BoundaryProfile, system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult>;
  readConfig(path: string): string;
  writeConfig(path: string, content: string): void;
  configPath?(app: string): string;
  mirrorTimeoutMs?: number;
  jobTimeoutMs?: number;
  /** OPTIONAL: post-confirm advisory-index. Absent → skip indexing. Fail-open: every failure
   *  (adapter err, unresolvable mirror, spawn timeout, thrown call) maps to a `failed` outcome.
   *  Called with the same mirrorDir ensureMirrorAtBranch resolved this round.
   */
  indexRepo?(repo: string, mirrorDir: string): Promise<RepoIndexOutcome>;
  /** Per-repo bound on indexRepo. Default 5 min. A timeout degrades that repo to `failed` and the phase continues. */
  indexTimeoutMs?: number;
  /** OPTIONAL: enqueue a `mode: context` run so onboarding writes e2e/.qa/context.json.
   *  Absent → skip mapping. Composition resolves HEAD in mirrorDir and calls enqueueTrackedRun with shadow: false. */
  enqueueContextRun?(input: ContextMapRunRequest): string | Promise<string>;
  /** OPTIONAL: poll the enqueued context run. Missing after a successful enqueue is fail-open. */
  getContextRun?(runId: string): ContextMapRunSnapshot | undefined;
  /** OPTIONAL: true for code-mode apps (no e2e/.qa/context.json). Missing ⇒ treat as e2e. */
  isCodeApp?(app: string): boolean;
  mappingPollMs?: number;
  mappingTimeoutMs?: number;
}

const DEFAULT_MIRROR_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_INDEX_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_MAPPING_POLL_MS = 1500;
const DEFAULT_MAPPING_TIMEOUT_MS = 60 * 60 * 1000;

function defaultConfigPath(app: string): string {
  return `config/apps/${app}.yaml`;
}

/* Rejects with `message` once `ms` elapses (calling `onTimeout` first so the caller can abort). */
function raceTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface OnboardingJob {
  /** With no argument (or an app matching the current/last job), returns the current job's status
   *  as-is. With an app that DIFFERS from the current job's app, returns a scoped idle response
   *  for the REQUESTED app instead — this process holds exactly one job at a time, and a caller
   *  polling a different app's URL must never see another app's in-flight or completed job (the
   *  per-app REST surface is a facade over one process-wide job; see src/index.ts's composition
   *  wiring for the app-identity thread-through this depends on). */
  status(app?: string): OnboardingJobStatus;
  /** Synchronous rejection ({ok:false}) when a job is already non-terminal (the mutex); otherwise a
   *  Promise<ProposeResult> that settles once the round finishes. The HTTP handler must NOT
   *  await this promise on the response path — that is what makes propose() fire-and-forget. */
  propose(req: ProposeBoundariesRequest): ProposeResult | Promise<ProposeResult>;
  /** With no argument (or an app matching the current job), behaves exactly as before. With an app
   *  that DIFFERS from the current job's app, rejects WITHOUT performing any write — confirming
   *  against the wrong app's URL must never splice another app's resolved profile into this app's
   *  config. */
  confirm(app?: string): ConfirmResult;
  /** Test/ops seam: resolves once the current (or most recent) propose() round has fully settled. */
  settled(): Promise<void>;
  /** True while a job is non-terminal in flight (from propose() until run()'s finally clears the
   *  mutex) — the mirror-race guard the QA runner polls (src/server/runner.ts's
   *  RunnerDeps.isOnboardingActive) to defer mirror provisioning while onboarding is running. A
   *  direct read of the module-private `busy` flag; no new state. */
  isActive(): boolean;
}

/** Builds a fresh in-memory OnboardingJob. One job instance = one mutex; src/index.ts constructs one. */
export function createOnboardingJob(deps: OnboardingJobDeps): OnboardingJob {
  let status: OnboardingJobStatus = { state: ONBOARD_STATE.idle, round: 0, ceiling: 3, candidatesScored: 0 };
  /*
   * The mutex flag is tracked independently of `status.state`: the very first status write inside
   * run() moves state OFF "idle" already, but tracking a dedicated boolean (rather than re-deriving
   * "busy" from state) keeps the mutex correct even across the instant between propose() being
   * called and run()'s first `await`.
   */
  let busy = false;
  let inFlight: Promise<void> | null = null;
  /*
   * Front + every service RepoRef this round's mirror phase resolved — indexing MUST run at the
   * same mirrorDir a later query resolves. Cleared on a fresh propose() so a stale round's mirrors
   * cannot be indexed under a new round's profile.
   */
  let lastRepoRefs: RepoRef[] = [];
  let pendingNoProfileMap = false;

  function fail(error: string): void {
    status = { ...status, state: ONBOARD_STATE.failed, error, finishedAt: new Date().toISOString() };
  }

  function shouldMap(app: string): boolean {
    if (!deps.enqueueContextRun) return false;
    if (!deps.isCodeApp) return true;
    try {
      return !deps.isCodeApp(app);
    } catch {
      return false;
    }
  }

  function finishDone(patch: Partial<OnboardingJobStatus> = {}): void {
    status = { ...status, ...patch, state: ONBOARD_STATE.done, finishedAt: new Date().toISOString() };
  }

  /* Wraps one repo's indexRepo with a per-repo timeout. Rejection, throw, or timeout → `failed`. Never throws. */
  async function indexOneRepo(repo: string, mirrorDir: string, indexTimeoutMs: number): Promise<RepoIndexOutcome> {
    try {
      return await raceTimeout(
        deps.indexRepo!(repo, mirrorDir),
        indexTimeoutMs,
        () => {},
        `indexing ${repo} timed out`,
      );
    } catch (err) {
      return { repo, status: REPO_INDEX_STATUS.failed, error: redactionPort.redactError(err) };
    }
  }

  /* Post-confirm advisory-index, sequential (front, then each service). Re-acquires `busy` for
   *  its duration so a QA checkout mid-index cannot tear the index. Does not set done — the
   *  post-confirm coordinator does. Never rethrows. */
  async function runIndexing(repoRefs: RepoRef[], indexTimeoutMs: number): Promise<void> {
    busy = true;
    status = { ...status, state: ONBOARD_STATE.indexing, indexProgress: [] };
    try {
      const progress: RepoIndexOutcome[] = [];
      for (const ref of repoRefs) {
        const outcome = await indexOneRepo(ref.repo, ref.mirrorDir, indexTimeoutMs);
        progress.push(outcome);
        status = { ...status, indexProgress: [...progress] };
      }
      status = { ...status, indexProgress: progress };
    } catch (err) {
      /* Defensive-only: indexOneRepo never throws. Stay non-terminal so mapping can still run. */
      status = { ...status, error: redactionPort.redactError(err) };
    } finally {
      busy = false;
    }
  }

  async function runMapping(app: string, mirrorDir: string): Promise<void> {
    status = { ...status, state: ONBOARD_STATE.mapping };
    try {
      const runId = await deps.enqueueContextRun!({ app, mirrorDir });
      if (!runId) {
        /* Spec skip: enqueue "" (shutdown) is not a fail-open warning. */
        finishDone();
        return;
      }
      status = { ...status, mappingProgress: { runId } };
      if (!deps.getContextRun) {
        finishDone({ error: "architecture map status unavailable" });
        return;
      }
      const pollMs = deps.mappingPollMs ?? DEFAULT_MAPPING_POLL_MS;
      const timeoutMs = deps.mappingTimeoutMs ?? DEFAULT_MAPPING_TIMEOUT_MS;
      const started = Date.now();
      for (;;) {
        const snap = deps.getContextRun(runId);
        if (snap) {
          status = {
            ...status,
            mappingProgress: { runId, step: snap.step, verdict: snap.verdict },
          };
          if (snap.status === "done") break;
        }
        if (Date.now() - started > timeoutMs) {
          finishDone({ error: "architecture map timed out" });
          return;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      finishDone();
    } catch (err) {
      finishDone({ error: redactionPort.redactError(err) });
    }
  }

  async function runPostConfirm(repoRefs: RepoRef[]): Promise<void> {
    try {
      if (deps.indexRepo && repoRefs.length > 0) {
        await runIndexing(repoRefs, deps.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS);
      }
      const app = status.app ?? "";
      const front = repoRefs[0];
      if (shouldMap(app) && front) {
        await runMapping(app, front.mirrorDir);
      } else {
        finishDone();
      }
    } catch (err) {
      finishDone({ error: redactionPort.redactError(err) });
    }
  }

  async function run(req: ProposeBoundariesRequest): Promise<void> {
    const mirrorTimeoutMs = deps.mirrorTimeoutMs ?? DEFAULT_MIRROR_TIMEOUT_MS;
    const jobTimeoutMs = deps.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const startedAt = new Date().toISOString();
    status = { state: ONBOARD_STATE.resolvingMirrors, app: req.app, round: 0, ceiling: 3, candidatesScored: 0, startedAt };
    lastRepoRefs = [];  /* fresh round — never index a stale round's mirrors under this round's profile */
    pendingNoProfileMap = false;

    try {
      /* Env-guard before the runner-busy guard and before resolvingMirrors — a missing key/agent must never burn a mirror cycle. */
      if (!deps.hasOpencodeApiKey()) {
        fail("OPENCODE_API_KEY is not set — the proposer cannot run");
        return;
      }
      const hasAgent = await deps.hasProposerAgent();
      if (!hasAgent) {
        fail("the qa-proposer agent is not configured on the opencode server");
        return;
      }

      /* Symmetric mirror-race guard — before resolvingMirrors. */
      if (deps.isRunnerBusy()) {
        fail("runner busy, retry later");
        return;
      }

      /*
       * resolvingMirrors — its OWN phase, its OWN timeout, BEFORE the round-budget clock starts.
       * Each repo's mirror is provisioned exactly once; front/system RepoRefs are built from the
       * SAME resolved mirror dirs (no duplicate ensureMirrorAtBranch calls).
       */
      const baseBranch = req.baseBranch ?? "main";
      let mirrorTimedOut = false;
      let mirrorDirs: string[];
      try {
        mirrorDirs = await raceTimeout(
          Promise.all([req.repo, ...req.services].map((repo) => deps.ensureMirrorAtBranch(repo, baseBranch))),
          mirrorTimeoutMs,
          () => { mirrorTimedOut = true; },
          "resolving mirrors timed out",
        );
      } catch (err) {
        fail(mirrorTimedOut ? "resolving mirrors timed out" : redactionPort.redactError(err));
        return;
      }

      const [frontMirrorDir, ...serviceMirrorDirs] = mirrorDirs;
      const front: RepoRef = { repo: req.repo, mirrorDir: frontMirrorDir! };
      const system: RepoRef[] = req.services.map((repo, i) => ({ repo, mirrorDir: serviceMirrorDirs[i]! }));
      lastRepoRefs = [front, ...system];  /* available to confirm()'s indexing kickoff */

      
      status = { ...status, state: ONBOARD_STATE.proposing };
      const controller = new AbortController();
      const proposer = deps.buildProposer({ app: req.app, signal: controller.signal });
      const onRound = (p: OnboardingRoundProgress): void => {
        status = {
          ...status,
          state: ONBOARD_STATE.scoring,
          round: p.round,
          candidatesScored: p.scored,
          lastResolvedScore: p.bestResolvedScore,
        };
      };
      const service = deps.buildOnboardingService(proposer, onRound);

      let timedOut = false;
      let result;
      try {
        result = await raceTimeout(
          service.onboard(system, front),
          jobTimeoutMs,
          () => { timedOut = true; controller.abort(); },
          "onboarding timed out",
        );
      } catch (err) {
        fail(timedOut ? "onboarding timed out" : redactionPort.redactError(err));
        return;
      }

      const finishedAt = new Date().toISOString();
      if (result.profile !== null) {
        let resolution: ResolutionSummary | undefined;
        if (deps.resolveLinks) {
          try {
            const resolved = await raceTimeout(
              deps.resolveLinks(result.profile, system, front),
              DEFAULT_RESOLVE_TIMEOUT_MS,
              () => {},
              "resolving links timed out",
            );
            resolution = aggregateResolution(resolved);
          } catch (err) {
            resolution = undefined;  /* advisory only — never flips the winner outcome */
            logJson("warn", "onboarding resolveLinks failed (advisory)", { error: redactionPort.redactError(err) });
          }
        }
        status = { ...status, state: ONBOARD_STATE.done, outcome: ONBOARD_OUTCOME.winner, resolvedProfile: result.profile, resolution, finishedAt };
      } else if (shouldMap(req.app) && lastRepoRefs.length > 0) {
        /*
         * Set mapping BEFORE run() returns so the TUI never observes a premature done/no-profile
         * and stops polling. busy is released in finally; propose()'s continuation then maps.
         */
        status = { ...status, state: ONBOARD_STATE.mapping, outcome: ONBOARD_OUTCOME.noProfile };
        pendingNoProfileMap = true;
      } else {
        status = { ...status, state: ONBOARD_STATE.done, outcome: ONBOARD_OUTCOME.noProfile, finishedAt };
      }
    } catch (err) {
      fail(redactionPort.redactError(err));
    } finally {
      busy = false;
    }
  }

  /*
   * True when `app` is provided and differs from the current/last job's app — i.e. the caller is
   * polling or confirming a URL for an app this process is NOT currently (or was never) running an
   * onboarding job for. `status.app` is undefined only at the very first idle state (before any
   * propose() call ever ran), in which case there is nothing to mismatch against.
   */
  function isOtherApp(app: string | undefined): boolean {
    return app !== undefined && status.app !== undefined && app !== status.app;
  }

  return {
    status(app?: string): OnboardingJobStatus {
      if (isOtherApp(app)) {
        /*
         * Scoped idle response for the REQUESTED app — never the other app's job data. Same shape
         * as the process's own initial idle state, just labeled with the caller's app.
         */
        return { state: ONBOARD_STATE.idle, app, round: 0, ceiling: 3, candidatesScored: 0 };
      }
      return status;
    },

    propose(req: ProposeBoundariesRequest): ProposeResult | Promise<ProposeResult> {
      if (busy || status.state === ONBOARD_STATE.mapping || status.state === ONBOARD_STATE.indexing) {
        return { ok: false, error: "an onboarding job is already running" };
      }
      busy = true;
      const promise = run(req).then(async (): Promise<ProposeResult> => {
        if (pendingNoProfileMap) {
          pendingNoProfileMap = false;
          const front = lastRepoRefs[0];
          if (front) await runMapping(status.app ?? req.app, front.mirrorDir);
        }
        return { ok: true };
      });
      inFlight = promise.then(() => undefined);
      return promise;
    },

    confirm(app?: string): ConfirmResult {
      if (isOtherApp(app)) {
        return { ok: false, error: `no confirmable job for app '${app}' (current job belongs to '${status.app}')` };
      }
      if (status.state !== ONBOARD_STATE.done || status.outcome !== ONBOARD_OUTCOME.winner || !status.resolvedProfile) {
        return { ok: false, error: "no confirmable boundary profile for this app" };
      }
      const resolvedApp = status.app ?? "";
      const path = (deps.configPath ?? defaultConfigPath)(resolvedApp);
      const lines = serializeBoundary(status.resolvedProfile);
      let existing: string;
      try {
        existing = deps.readConfig(path);
      } catch (err) {
        return { ok: false, error: redactionPort.redactError(err) };
      }
      try {
        const spliced = spliceBoundariesBlock(existing, lines);
        deps.writeConfig(path, spliced);
      } catch (err) {
        return { ok: false, error: redactionPort.redactError(err) };
      }
      /*
       * Boundaries are WRITTEN at this point — onboarding has durably succeeded regardless of
       * what indexing/mapping does next. Both tails are fire-and-forget: confirm() returns
       * synchronously. Additive-optional — without indexRepo AND without enqueueContextRun the
       * job stays done.
       */
      const wantsIndex = Boolean(deps.indexRepo && lastRepoRefs.length > 0);
      const wantsMap = shouldMap(resolvedApp) && lastRepoRefs.length > 0;
      if (wantsIndex || wantsMap) {
        inFlight = runPostConfirm(lastRepoRefs);
      }
      return { ok: true };
    },

    async settled(): Promise<void> {
      if (inFlight) await inFlight;
    },

    isActive(): boolean {
      return busy;
    },
  };
}
