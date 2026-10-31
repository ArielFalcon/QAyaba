/*
 * Work a run is preceded by on the same sequential queue: the app's login bootstrap, when its suite store holds no verified login,
 * and a rebuild of its context map, when the map does not describe the run's commit. Each happens once, and only for a run that
 * can use what it prepares.
 */
import { RUN_PURPOSE, type RunMode, type RunPurpose } from "@kernel/run-mode.ts";

/*
 * What a login-bootstrap run is told. App-agnostic: the app's login comes from its own declaration (the test account in the run's
 * environment), the page to prove it on from the app's own routes. The run is a manual generation, so the generator's login section
 * (the stock seed did not sign in) and every gate apply as for any run; the login is kept only because the run was accepted.
 */
export const LOGIN_BOOTSTRAP_GUIDANCE = [
  "Establish and prove the app's login.",
  "Make e2e/auth.setup.ts sign in with the configured test account (DEV_TEST_USER and DEV_TEST_PASS) so that the session it saves reaches the app's signed-in area.",
  "Then write one smoke spec that opens one route that needs that session and asserts something only a signed-in user sees.",
  "Write no other spec, and do not change the app's code.",
].join(" ");

/* What of a request decides whether work may precede its run. */
export interface PreworkRequest {
  mode: RunMode;
  purpose?: RunPurpose | undefined;
  triggerRepo?: string | undefined;
  parentRunId?: string | undefined;
}

/*
 * Whether work may precede the run: not a frozen request (a campaign keeps control of the suite's warmth and of its map), not a
 * context run (onboarding queues its own bootstrap after it), not a run that is itself for a purpose, not a cross-repo run (its
 * sha belongs to the service repo) and not a continuation.
 */
export function mayBePreceded(req: PreworkRequest, frozen: boolean): boolean {
  return !(frozen || req.mode === "context" || req.purpose !== undefined || req.triggerRepo !== undefined || req.parentRunId !== undefined);
}

/* An app that declares a login and whose suite store holds none starts cold and authors the login while it does something else. The store is asked only for an app that declares a login. */
export function needsLoginBootstrap(declaresLogin: boolean, storeHoldsVerifiedLogin: () => boolean): boolean {
  return declaresLogin && !storeHoldsVerifiedLogin();
}

/*
 * The apps whose login bootstrap this process has queued, by anyone: an operator, onboarding, or the automatic one. It is the
 * whole of "once": a bootstrap that is pending or running is in it, and so is one that finished or failed. A failed bootstrap
 * therefore never triggers another on the next run (that would repeat the same failure on every run, each time ahead of the
 * run that was asked for); it is retried by a restart or by asking for it, and a bootstrap that worked leaves a login in the
 * store, so the question is not asked again anyway. The app commits whose context map this process has rebuilt (or tried to) are
 * the same for the map: a rebuild that failed is not repeated by every run at that commit. Memory only, on purpose: nothing
 * persistent can wedge an app off a warm start.
 */
export class PreworkMemory {
  private readonly loginBootstrapAsked = new Set<string>();
  private readonly contextMapRebuilt = new Set<string>();

  loginBootstrapWasAsked(app: string): boolean {
    return this.loginBootstrapAsked.has(app);
  }

  askedLoginBootstrap(app: string): void {
    this.loginBootstrapAsked.add(app);
  }

  contextMapWasRebuilt(app: string, sha: string): boolean {
    return this.contextMapRebuilt.has(`${app}@${sha}`);
  }

  rebuiltContextMap(app: string, sha: string): void {
    this.contextMapRebuilt.add(`${app}@${sha}`);
  }
}

/* A login-bootstrap run: a manual e2e generation whose purpose is the app's login. It is accepted like any run (green, reviewed, not held back by coverage), and an accepted run keeps the login and its smoke spec in the suite store. Under the app's own qa.shadow; never given a triggerRepo. */
export function loginBootstrapRequest(app: string, sha: string) {
  return { app, sha, target: "e2e", mode: "manual", source: "manual", guidance: LOGIN_BOOTSTRAP_GUIDANCE, purpose: RUN_PURPOSE.LOGIN_BOOTSTRAP, trigger: "login-bootstrap" } as const;
}

/* A context-map run: an e2e run in context mode at an explicit sha, from a manual source. Never given a triggerRepo: context mode cannot be driven from a service repo. */
export function contextMapRequest(app: string, sha: string, parentRunId?: string) {
  return { app, sha, target: "e2e", mode: "context", source: "manual", trigger: "context", ...(parentRunId ? { parentRunId } : {}) } as const;
}

/* The rebuild that serves a run holds the queue and has made no data yet: it is not an interrupted run to clean up after (previousNamespace ""). */
export function contextMapRebuildRequest(app: string, sha: string, servedRunId: string) {
  return { app, sha, target: "e2e", mode: "context", source: "manual", trigger: "context", parentRunId: servedRunId, previousNamespace: "" } as const;
}
