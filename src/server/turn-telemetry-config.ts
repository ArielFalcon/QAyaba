/*
 * What classifies an agent step for a run's trace, built from the app's own configuration and nothing else: where its tests are
 * written, which file and which addresses are its login, and which agents judge instead of author. Never from a name, a stack or
 * a model. The engine's classifiers (qa-engine/.../domain/step-intent.ts, nav-outcome.ts) are pure functions of this context.
 */
import type { TestTarget } from "@kernel/run-mode";
import type { StepIntentContext } from "@contexts/generation/domain/step-intent";
import { AUTH_SETUP_PATH } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter";

export interface StepIntentConfigInput {
  target: TestTarget;
  /* The suite directory, relative to the working copy (e2e target). */
  e2eRelDir: string;
  /* The app's DEV address and its declared login path, when it has them. */
  baseUrl?: string;
  loginPath?: string;
  /* Agent names that judge rather than author. */
  reviewAgents: readonly string[];
}

function absolute(path: string, base: string): URL | undefined {
  try {
    return new URL(path, base);
  } catch {
    return undefined;
  }
}

export function stepIntentContextFor(input: StepIntentConfigInput): StepIntentContext {
  const code = input.target === "code";
  const login = !code && input.baseUrl !== undefined && input.loginPath !== undefined ? absolute(input.loginPath, input.baseUrl) : undefined;
  const app = input.baseUrl !== undefined ? absolute("/", input.baseUrl) : undefined;
  return {
    /* A code target writes tests in the repo's own layout: every write is a test. */
    specTargets: code ? { kind: "any-write" } : { kind: "dir", relDir: input.e2eRelDir },
    authFiles: code ? [] : [`${input.e2eRelDir}/${AUTH_SETUP_PATH}`],
    loginUrls: login ? [login.href] : [],
    /* A login on an origin of its own: every page there is a login step. */
    authOnlyOrigins: login && app && login.origin !== app.origin ? [login.origin] : [],
    reviewAgents: input.reviewAgents,
  };
}

/*
 * QA_TELEMETRY_OBSERVE_UNWATCHED=true has the host track the calls of a session that opted out of live observation (the explorer's)
 * so its turn has a trace. Off unless the operator turns it on: it adds an event-stream subscription to a phase that had none.
 * Read once by the composition root, because qa-engine never reads the environment.
 */
export function observeUnwatchedFromEnv(env: Record<string, string | undefined>): boolean {
  return env.QA_TELEMETRY_OBSERVE_UNWATCHED?.trim().toLowerCase() === "true";
}
