/*
 * Whether a failed call ended on the app's login page: a spec that logged out, or a session DEV let expire, leaves the next
 * spec facing a login form it was never written for. The evidence is what the failure capture already holds (the failing
 * page's final URL and its accessible tree), so reading it costs nothing and starts no browser.
 */

import type { QaCase } from "@kernel/qa-case.ts";

const LOGIN_PATH = /\/(?:log-?in|sign-?in|sso|auth(?:enticate)?)(?:[/?#]|$)/i;
const PASSWORD_FIELD = /^textbox: .*(?:password|contrase(?:ñ|n)a|clave)/im;

export function endedOnLoginWall(cases: readonly Pick<QaCase, "status" | "finalUrl" | "failureDom">[]): boolean {
  return cases.some((c) => {
    if (c.status !== "fail") return false;
    if (c.finalUrl !== undefined && LOGIN_PATH.test(pathOf(c.finalUrl))) return true;
    return c.failureDom !== undefined && PASSWORD_FIELD.test(c.failureDom);
  });
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
