/*
 * Whether the page an agent's browser call ended on says the session is gone: the app sent it to its login page, answered
 * its document with 401, or shows a password field where it did not ask to be. Pure: the host reports what it saw, the
 * verdict is here. A session that DEV let expire is the one failure the agent cannot be left to interpret by itself, since
 * every page it reads afterwards would be a login form it takes for the app.
 */

import { pathLooksLikeLogin } from "./login-wall.ts";

export const INVALIDATION_KIND = {
  LOGIN_PAGE: "login-page",
  UNAUTHORIZED: "unauthorized",
  PASSWORD_FIELD: "password-field",
} as const;

export type InvalidationKind = (typeof INVALIDATION_KIND)[keyof typeof INVALIDATION_KIND];

export interface PageObservation {
  /* Where the page ended. */
  url: string;
  /* The path the call asked for (a navigation's target, otherwise the page it was already on). */
  requestedPath: string;
  /* The status of the page's main document, when the call loaded one. */
  documentStatus?: number | undefined;
  passwordFieldVisible: boolean;
}

export interface Invalidation {
  kind: InvalidationKind;
  /* What was seen, without a query, a fragment or credentials. */
  detail: string;
}

export interface InvalidationHints {
  /* The path the app's login form lives at (auth.loginPath), when it declares one. */
  loginPath?: string | undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function underPath(path: string, base: string): boolean {
  const clean = base.endsWith("/") ? base.slice(0, -1) : base;
  return path === clean || path.startsWith(`${clean}/`);
}

export function detectInvalidation(observation: PageObservation, hints: InvalidationHints): Invalidation | undefined {
  const path = pathOf(observation.url);
  if (pathLooksLikeLogin(path) || (hints.loginPath !== undefined && hints.loginPath.startsWith("/") && underPath(path, hints.loginPath))) {
    return { kind: INVALIDATION_KIND.LOGIN_PAGE, detail: `the page ended on the login path ${path}` };
  }
  if (observation.documentStatus === 401) return { kind: INVALIDATION_KIND.UNAUTHORIZED, detail: `the page ${path} answered 401` };
  if (observation.passwordFieldVisible && path !== observation.requestedPath) {
    return { kind: INVALIDATION_KIND.PASSWORD_FIELD, detail: `a password field is showing on ${path}, which was not the page asked for` };
  }
  return undefined;
}
