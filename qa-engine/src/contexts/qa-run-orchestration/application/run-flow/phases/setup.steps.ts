/* The setup of a run: the accepted suite comes back, the project is set up, the login is prepared, a prior run's data is cleaned and the run's authoring handles (location, run_spec loop, agent browser) are opened. */

import { RUN_PURPOSE } from "@kernel/run-mode.ts";
import { terminalForPrecondition } from "../../../domain/helpers/precondition-terminal.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, GeolocationHandle } from "../../ports/index.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { carryOn } from "../failure-policy.ts";

type Result = Promise<StepOutcome<RunState>>;

/*
 * The accepted suite comes back before the project setup: the checkout has just wiped every untracked file of the mirror, and the
 * setup would otherwise seed the stock login and nothing else. A fault here is a cold run, said aloud, not a failed one; the
 * run then captures nothing, since the working copy was never compared with the store.
 */
export async function restoreAcceptedSuite(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, cfg, input, workspace } = ctx;
  let suiteRestored = false;
  let storeRestoredLogin = false;
  if (deps.suiteStore && !cfg.isCode && input.mode !== "context") {
    try {
      const restored = await deps.suiteStore.restore({ mirrorDir: workspace.mirrorDir, specDir: workspace.specDir });
      suiteRestored = true;
      storeRestoredLogin = restored.authRestored;
      ctx.host.announceSuite(
        `[qa] suite store: restored ${restored.restored} file(s), overlaid ${restored.overlaid} unpublished change(s) over git, left ${restored.trackedWins} to git${restored.authRestored ? "; the app's login was restored" : ""}`,
        "info",
      );
    } catch (err) {
      carryOn(err);
      ctx.host.announceSuite(`[qa] suite store restore failed (off-path; the run starts cold and keeps nothing): ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  }
  return { update: { setup: { ...state.setup, suiteRestored, storeRestoredLogin } } };
}

/*
 * After classify (skip already returned) and before generate. A throw is
 * infra-error, never a code verdict, and is not persisted.
 */
export async function setUpProject(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, signal } = ctx;
  if (deps.setup) {
    deps.observer?.onStep("setup");
    try {
      await deps.setup.setup(workspace.specDir, signal);
    } catch (err) {
      /* Never swallow an integration error into an empty result. */
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[qa] setup phase failed:", err);
      return end("setup-failed", { note: `setup failed: ${msg}` });
    }
  }
}

export async function prepareLogin(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { cfg, input, workspace, signal } = ctx;
  const { generating } = state.classification;
  let authSeedUnauthored = false;
  if (!cfg.isCode) {
    let auth = await ctx.host.prepareAuth(workspace.specDir, "pre-generate", signal);
    if ("failed" in auth && state.setup.storeRestoredLogin) {
      /* The login the store brought back no longer signs in (the app changed since): the stock seed takes its place and the login is tried once more, which falls into discovery or the unauthored path. */
      const healed = await ctx.host.replaceRestoredLogin(workspace, signal);
      if (healed === "setup-failed") return end("auth-failed", { note: "setup failed while the app's stored login was replaced by the stock one" });
      if (healed === "replaced") auth = await ctx.host.prepareAuth(workspace.specDir, "pre-generate", signal);
    }
    if ("failed" in auth) return end("auth-failed", { note: auth.failed });
    if ("precondition" in auth) {
      const terminal = terminalForPrecondition(input.mode);
      ctx.host.announcePrecondition(auth.precondition, terminal.action === "end");
      if (terminal.action === "end") {
        return end("login-precondition", { generating, note: ctx.host.preconditionNote(auth.precondition) });
      }
    } else {
      authSeedUnauthored = auth.unauthored;
    }
  }
  return { update: { setup: { ...state.setup, authSeedUnauthored } } };
}

/*
 * Orphan-data cleanup for a PRIOR interrupted run. e2e-only; requires
 * previousNamespace. Failure is logged and MUST NEVER alter this run's verdict.
 */
export async function cleanPriorRun(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, cfg, input, workspace, signal } = ctx;
  if (deps.cleanup && input.previousNamespace && !cfg.isCode) {
    deps.observer?.onStep("setup", "orphan-data cleanup (prior interrupted run)");
    try {
      await deps.cleanup.cleanup(workspace.specDir, {
        namespace: input.previousNamespace,
        signal,
      });
    } catch (err) {
      console.error(`[qa] cleanup warning (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/* Whether the run authors e2e tests with a login the suite can use: the only runs that are granted the authoring handles. */
function grantsAuthoringHandles(state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean {
  return state.classification.generating && !ctx.cfg.isCode && ctx.input.mode !== "context" && ctx.input.purpose !== RUN_PURPOSE.LOGIN_BOOTSTRAP && !state.setup.authSeedUnauthored;
}

/*
 * The authoring location: the app's declared default and places, the lead's value and one value per flow. Opened before the
 * browser and the loop so both can consume it; a fault opening it costs the run only the location. Its facts are read again
 * on every generation turn, since the lead may move it while it authors.
 *
 * The run_spec loop: only for a run that writes e2e tests with a login the suite can use. A fault opening it costs the run only
 * the loop. Its facts reach every generation of the run (the first pass and each regeneration) through baseEnrichment.
 *
 * The authenticated agent browser and the lead's code-graph tools: the same runs, the same moment. A fault opening one costs the
 * run only that handle.
 *
 * The handles are live objects: they are kept on the run's trail, where the run's end closes them.
 */
export async function openAuthoringHandles(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace, signal, trail } = ctx;
  const granted = grantsAuthoringHandles(state, ctx);
  let geolocation: GeolocationHandle | undefined;
  if (deps.geolocation && granted) {
    try {
      geolocation = await deps.geolocation.open({
        runId: input.runId,
        app: input.app,
        mode: input.mode,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      carryOn(err);
      console.error(`[qa] the authoring location could not be opened (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
    }
    trail.geolocation = geolocation;
  }

  let closedLoop: ClosedLoopHandle | undefined;
  if (deps.closedLoop && granted) {
    try {
      closedLoop = await deps.closedLoop.open({
        runId: input.runId,
        app: input.app,
        mode: input.mode,
        mirrorDir: workspace.mirrorDir,
        specDir: workspace.specDir,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.closedLoop !== undefined ? { enabled: input.closedLoop } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      carryOn(err);
      console.error(`[qa] the run_spec loop could not be opened (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
    }
    trail.closedLoop = closedLoop;
  }

  let agentBrowser: AgentBrowserHandle | undefined;
  if (deps.agentBrowser && granted) {
    try {
      const geo = geolocation;
      agentBrowser = await deps.agentBrowser.open({
        runId: input.runId,
        app: input.app,
        mode: input.mode,
        specDir: workspace.specDir,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.agentBrowser !== undefined ? { enabled: input.agentBrowser } : {}),
        ...(signal ? { signal } : {}),
        ...(geo ? { geolocation: { default: geo.default, forSession: (sessionId: string) => geo.forSession(sessionId) } } : {}),
      });
    } catch (err) {
      carryOn(err);
      console.error(`[qa] the agent browser could not be opened (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
    }
    trail.agentBrowser = agentBrowser;
  }

  /* The lead's code-graph tools: the same runs as the browser. The graph was synced in the index phase, before this. */
  if (deps.codeGraphTools && granted) {
    try {
      trail.codeGraphTools = await deps.codeGraphTools.open({ runId: input.runId });
    } catch (err) {
      carryOn(err);
      console.error(`[qa] the code-graph tools could not be opened (the run goes on without them): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
