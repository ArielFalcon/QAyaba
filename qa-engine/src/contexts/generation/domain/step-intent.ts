/*
 * What an agent step was for, as a closed set, from the calls it made. Pure and config-fed: the places that matter (where specs
 * live, which files and addresses are the app's login) come from the context the caller builds out of the app's own configuration,
 * never from a name, a model or an app. Priority within a step: running a spec, then touching the login, then writing a spec,
 * then a reviewer's work, then exploring.
 */
import { CALL_BUCKETS, type CallBucket } from "./tool-call-taxonomy.ts";
import { isNavigationCall } from "./nav-outcome.ts";

export const STEP_INTENTS = ["write_spec", "auth", "run_spec", "explore", "review", "other"] as const;
export type StepIntent = (typeof STEP_INTENTS)[number];

export interface StepIntentContext {
  /* Where the agent's tests are written: a directory (an e2e suite), or anywhere (a code target writes tests in the repo's own layout). */
  specTargets: { kind: "dir"; relDir: string } | { kind: "any-write" };
  /* Files that hold the app's login, relative to the working copy. */
  authFiles: readonly string[];
  /* Absolute addresses of the app's declared login page(s). */
  loginUrls: readonly string[];
  /* Origins that exist only to authenticate. */
  authOnlyOrigins: readonly string[];
  /* Agent names whose work is judging, not authoring. */
  reviewAgents: readonly string[];
}

/* One call of a step, as the tracker saw it: the target is redacted and capped, the path is relative to the working copy when it lies inside. */
export interface StepCall {
  tool: string;
  bucket: CallBucket;
  targetKind: "path" | "pattern" | "url" | "command" | "query" | "element" | null;
  target: string | null;
  relPath?: string;
}

export interface StepOfCalls {
  calls: readonly StepCall[];
}

const RUN_SPEC_TOOL = /(^|_)run_spec$/i;
const AUTHBROWSER_TOOL = /(^|_)authbrowser_/i;

const isBrowserCall = (call: StepCall): boolean => call.bucket === CALL_BUCKETS.BROWSER || AUTHBROWSER_TOOL.test(call.tool);

const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

function underDir(relPath: string, relDir: string): boolean {
  const dir = normalizePath(relDir);
  const path = normalizePath(relPath);
  return dir === "" || dir === "." ? !path.startsWith("..") : path === dir || path.startsWith(`${dir}/`);
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/* Whether a navigation target is one of the login steps the context declares. */
function isLoginAddress(address: string, ctx: StepIntentContext): boolean {
  const url = parse(address);
  if (url === undefined) return false;
  if (ctx.authOnlyOrigins.includes(url.origin)) return true;
  return ctx.loginUrls.some((login) => {
    const declared = parse(login);
    return declared !== undefined && declared.origin === url.origin && declared.pathname.replace(/\/+$/, "") === url.pathname.replace(/\/+$/, "");
  });
}

const touchesAuthFile = (call: StepCall, ctx: StepIntentContext): boolean =>
  call.relPath !== undefined && ctx.authFiles.some((file) => normalizePath(file) === normalizePath(call.relPath!));

/* One intent per step, in order. The login page the browser stands on carries from step to step until the agent navigates elsewhere. */
export function classifyStepIntents(steps: readonly StepOfCalls[], ctx: StepIntentContext, agent: string): StepIntent[] {
  const reviewer = ctx.reviewAgents.includes(agent);
  let onLoginPage = false;
  return steps.map((step) => {
    const calls = step.calls;
    const startedOnLogin = onLoginPage;
    for (const call of calls) {
      if (isNavigationCall(call.tool) && call.target !== null) onLoginPage = isLoginAddress(call.target, ctx);
    }
    if (calls.some((call) => RUN_SPEC_TOOL.test(call.tool))) return "run_spec";
    if (calls.some((call) => touchesAuthFile(call, ctx))) return "auth";
    const loginWork = calls.some((call) => (isNavigationCall(call.tool) ? call.target !== null && isLoginAddress(call.target, ctx) : startedOnLogin && isBrowserCall(call)));
    if (loginWork) return "auth";
    const writesSpec = calls.some(
      (call) => call.bucket === CALL_BUCKETS.WRITE && (ctx.specTargets.kind === "any-write" || (call.relPath !== undefined && underDir(call.relPath, ctx.specTargets.relDir))),
    );
    if (writesSpec) return "write_spec";
    if (reviewer && calls.length > 0) return "review";
    if (calls.some((call) => call.bucket === CALL_BUCKETS.CODE_READ || call.bucket === CALL_BUCKETS.MEMORY || isBrowserCall(call))) return "explore";
    return "other";
  });
}
