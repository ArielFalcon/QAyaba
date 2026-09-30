/*
 * Runs the login discovery script as a sandboxed one-shot child and turns what it printed into the
 * evidence the classifier reads. The script is written to a fresh temp directory outside the watched
 * repo and removed afterwards, the child runs in the spec dir under a hard kill, and the account
 * reaches it through its env alone: the JSON input it is given holds none. A child that dies is never
 * swallowed: it is logged with the account removed and reported as a crash, saying whether a submit
 * had already gone out (the stock seed must not submit again after one). This module is a protected
 * path: it starts the process that holds the credentials.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxedBinaryRunner } from "../../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { FORM_STATE, scrubSecrets, type LoginEvidence } from "../../domain/helpers/login-evidence.ts";
import { buildLoginDiscoveryScript } from "./login-discovery.script.ts";

/** How long the child may run before its whole process tree is killed: the ladder budget, the post-submit wait and the fresh-context check, with room to spare. */
export const LOGIN_DISCOVERY_HARD_KILL_MS = 75_000;

/** The most a crash writes to the log in one line after the account is removed. */
export const LOGGED_TEXT_MAX = 2_000;

export interface LoginDiscoveryInput {
  /** The suite directory the child runs in; its own `playwright` is the one loaded. */
  specDir: string;
  baseUrl: string;
  loginPath?: string;
  routes: readonly string[];
  storageStatePath: string;
  /** The seed config's action timeout, in ms: the wait after the submit grows with it. */
  actionTimeoutMs?: number;
  /** The child's whole env, account included; nothing else is added but the input JSON. */
  env: Record<string, string>;
}

/** What one discovery attempt leaves: the evidence, or a crash that says whether a credential had been submitted. */
export type LoginDiscoveryResult = LoginEvidence | { crashed: true; attempted: boolean };

export interface LoginDiscoveryRunnerDeps {
  runner: SandboxedBinaryRunner;
  /** Where a crash and the child's own complaints are reported; console.error unless a test says otherwise. */
  log?(line: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string";
const isNullableText = (value: unknown): value is string | null => value === null || typeof value === "string";

/* Just enough of a shape check to refuse an evidence line the classifier would trip over; the values were already bounded and scrubbed by the child. */
function isLoginEvidence(value: unknown): value is LoginEvidence {
  if (!isRecord(value)) return false;
  const flags = ["ladderHadPasswordField", "challengeVisible", "secondFactorVisible", "filled", "submitted", "inFlightAtDeadline", "newExceptionAfterSubmit", "submitDisabled", "passwordGone", "freshContextChecked", "freshContextPasswordGone", "storageStateWritten"];
  return (
    Array.isArray(value.ladder) && value.ladder.every(isText) &&
    Object.values(FORM_STATE).some((state) => state === value.form) &&
    isRecord(value.markers) && typeof value.markers.captcha === "boolean" && typeof value.markers.sso === "boolean" &&
    flags.every((flag) => typeof value[flag] === "boolean") &&
    Array.isArray(value.requests) && value.requests.every((r) => isRecord(r) && isText(r.method) && isText(r.pathname) && (r.status === null || typeof r.status === "number")) &&
    typeof value.pageErrorCount === "number" && isNullableText(value.firstPageError) && isNullableText(value.firstNewException) && isNullableText(value.firstAlert) &&
    isText(value.finalPath)
  );
}

interface ChildOutput {
  submitted: boolean;
  evidence: LoginEvidence | undefined;
  /** Lines that were not the child's protocol. */
  stray: string[];
}

function readChildOutput(stdout: string): ChildOutput {
  const output: ChildOutput = { submitted: false, evidence: undefined, stray: [] };
  for (const line of stdout.split("\n").filter((text) => text.trim().length > 0)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { output.stray.push(line); continue; }
    if (isRecord(parsed) && parsed.marker === "submitted") output.submitted = true;
    else if (isRecord(parsed) && "evidence" in parsed && isLoginEvidence(parsed.evidence)) output.evidence = parsed.evidence;
    else output.stray.push(line);
  }
  return output;
}

/* A spawn that failed before the child existed proves nothing was submitted; any other failure (an overflow kill, say) may have lost the marker. */
const failedBeforeStart = (error: unknown): boolean => isRecord(error) && typeof error.syscall === "string" && error.syscall.startsWith("spawn");

export function createDiscoverLogin(deps: LoginDiscoveryRunnerDeps): (input: LoginDiscoveryInput, signal?: AbortSignal) => Promise<LoginDiscoveryResult> {
  const log = deps.log ?? ((line: string): void => console.error(line));
  return async (input, signal) => {
    /* An abort that came before the child started must not start one. */
    if (signal?.aborted) return { crashed: true, attempted: false };
    const secrets = [input.env.DEV_TEST_USER, input.env.DEV_TEST_PASS].filter((secret): secret is string => secret !== undefined && secret !== "");
    /* Everything the child says about itself is untrusted text: the account comes out by exact value before it is logged. */
    const report = (what: string, text: string): void => log(`[qa] login discovery ${what}: ${scrubSecrets(text, secrets).slice(0, LOGGED_TEXT_MAX)}`);
    const work = mkdtempSync(join(tmpdir(), "qa-login-"));
    try {
      const script = join(work, "login-discovery.cjs");
      writeFileSync(script, buildLoginDiscoveryScript(join(input.specDir, "node_modules", "playwright")));
      const childInput = {
        baseUrl: input.baseUrl,
        routes: input.routes,
        storageStatePath: input.storageStatePath,
        ...(input.loginPath !== undefined ? { loginPath: input.loginPath } : {}),
        ...(input.actionTimeoutMs !== undefined ? { actionTimeoutMs: input.actionTimeoutMs } : {}),
      };
      let result;
      try {
        result = await deps.runner.run({
          command: "node",
          args: [script],
          cwd: input.specDir,
          env: { ...input.env, PW_LOGIN_INPUT: JSON.stringify(childInput) },
          timeoutMs: LOGIN_DISCOVERY_HARD_KILL_MS,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        report("crashed", error instanceof Error ? error.message : String(error));
        return { crashed: true, attempted: !failedBeforeStart(error) };
      }
      const output = readChildOutput(result.stdout);
      if (result.stderr.trim().length > 0) report("stderr", result.stderr);
      if (output.stray.length > 0) report("printed something other than evidence", output.stray.join("\n"));
      if (output.evidence !== undefined) return output.evidence;
      report("crashed", `no usable evidence (exit ${result.exitCode}${result.timedOut ? ", timed out or aborted" : ""})`);
      return { crashed: true, attempted: output.submitted };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
}
