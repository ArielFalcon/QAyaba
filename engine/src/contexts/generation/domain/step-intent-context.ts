/*
 * What classifies an agent step for a run's trace, built from the app's own configuration and nothing else: where its tests are
 * written, which file and which addresses are its login, and which agents judge instead of author. Never from a name, a stack or
 * a model. The classifiers (step-intent.ts, nav-outcome.ts) are pure functions of this context.
 */
import type { StepIntentContext } from "./step-intent.ts";

/* The app's login script, relative to its suite directory. */
export const LOGIN_SCRIPT_FILE = "auth.setup.ts";

export interface StepIntentConfigInput {
  /* The suite directory, relative to the working copy. */
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
  const login = input.baseUrl !== undefined && input.loginPath !== undefined ? absolute(input.loginPath, input.baseUrl) : undefined;
  const app = input.baseUrl !== undefined ? absolute("/", input.baseUrl) : undefined;
  return {
    specTargets: { kind: "dir", relDir: input.e2eRelDir },
    authFiles: [`${input.e2eRelDir}/${LOGIN_SCRIPT_FILE}`],
    loginUrls: login ? [login.href] : [],
    /* A login on an origin of its own: every page there is a login step. */
    authOnlyOrigins: login && app && login.origin !== app.origin ? [login.origin] : [],
    reviewAgents: input.reviewAgents,
  };
}
