/*
 * One `run_spec` call: the generator asks to execute a spec it wrote, the orchestrator decides whether it may, runs it once
 * in the sandbox against DEV under a namespace of its own, cleans what it created, and answers with a bounded, redacted
 * report. Nothing the generator controls decides a limit: the path is confined to this suite's spec files, the number of
 * calls, their time and the writes they may send to DEV are counted here, and the answer never carries raw process output.
 */

import { createHash } from "node:crypto";
import { MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { importsTestFromFixtures } from "../../../shared-infrastructure/spec-fixtures-import.ts";
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { AccountLock } from "../domain/account-lock.ts";
import { endedOnLoginWall } from "../domain/login-wall.ts";
import {
  RUN_SPEC_STATUS,
  type CallBudget,
  type ClosedLoopRefusalCode,
  type RunSpecCapability,
  type RunSpecStatus,
} from "../domain/run-spec-capability.ts";
import type { SessionRenewalPort, SpecCleanupPort, SpecExecutionResult, SpecExecutorPort } from "./ports/run-spec.ports.ts";

export const MAX_GREP_CHARS = 200;
export const MAX_ERROR_CHARS = 2_000;
export const MAX_FAILURE_DOM_CHARS = 8_000;
export const MAX_TITLE_CHARS = 300;
export const MAX_REPORTED_TESTS = 30;

/* The same shape the Playwright runner insists on for a spec file it is handed (e2e-execution.runner.ts SPEC_FILE_RE); a test keeps the two equal. */
export const SPEC_PATH_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.spec\.ts$/;

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", ".auth", ".qa", ".git", "test-results"]);
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export const RUN_SPEC_INVALID = {
  INVALID_REQUEST: "invalid-request",
  NOT_FOUND: "not-found",
} as const;

export type RunSpecRefusalCode = ClosedLoopRefusalCode | (typeof RUN_SPEC_INVALID)[keyof typeof RUN_SPEC_INVALID];

export interface RunSpecRequest {
  sessionId: string;
  agent: string;
  path: string;
  grep?: string;
}

export interface RunSpecTestReport {
  title: string;
  status: "passed" | "failed";
  durationMs?: number;
  error?: { message: string };
  failureDom?: string;
  finalUrl?: string;
}

export interface RunSpecReport {
  status: RunSpecStatus;
  tests: RunSpecTestReport[];
  budget: CallBudget;
  note?: string;
  /* The saved session ended on the login page and could not be renewed from here: the tests' results say nothing about the spec. */
  sessionLost?: true;
}

export type RunSpecResponse =
  | { ok: true; report: RunSpecReport }
  | { ok: false; code: RunSpecRefusalCode; message: string; budget: CallBudget };

export interface RunSpecDeps {
  capability: RunSpecCapability;
  specRoot: SpecRoot;
  /* The spec directory as the agent sees it from the mirror's root (`e2e`): a path may carry it as a prefix. */
  specRelDir: string;
  /* The key two users of one test account contend on. */
  account: string;
  lock: AccountLock;
  executor: SpecExecutorPort;
  cleanup: SpecCleanupPort;
  /* Absent: a lost session is only reported. */
  session?: SessionRenewalPort;
  /* Absent: no deadline bounds the call but its own cap. */
  deadline?: RunDeadlineView;
  /* Takes the run's secrets out of any text that leaves; the run's own scope must be active when it is called. */
  redact: (text: string) => string;
  signal?: AbortSignal;
}

/* A fragment of a test title as a regular expression that matches exactly that text. */
export function escapeGrep(fragment: string): string {
  return fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return cut(url.split(/[?#]/)[0] ?? "", 500);
  }
}

export class RunSpecUseCase {
  constructor(private readonly deps: RunSpecDeps) {}

  /* `callSignal` is this call's own cancellation (its generator session ended); the run's cancellation (`deps.signal`) stops it too. */
  async run(request: RunSpecRequest, callSignal?: AbortSignal): Promise<RunSpecResponse> {
    const { capability, deadline } = this.deps;
    const stop = callSignal && this.deps.signal ? AbortSignal.any([callSignal, this.deps.signal]) : (callSignal ?? this.deps.signal);
    const refused = capability.authorize(request.sessionId, request.agent);
    if (refused) return this.refusal(refused.code, refused.message);

    const rel = this.confinedPath(request.path);
    if (typeof rel !== "string") return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, rel.message);
    const grep = this.grepOf(request.grep);
    if (typeof grep === "object") return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, grep.message);

    const read = readOwnedSpecFile(this.deps.specRoot, rel, MAX_SPEC_SOURCE_BYTES);
    if ("absent" in read) return this.refusal(RUN_SPEC_INVALID.NOT_FOUND, `spec not found: ${rel}. Write it under the e2e directory first.`);
    if ("reason" in read) return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, `${rel} cannot be used: ${read.reason}`);
    const source = read.bytes.toString("utf8");
    if (!importsTestFromFixtures(source)) {
      return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, `${rel} must import test from the suite's fixtures file (for example: import { test, expect } from "./fixtures"), so that its requests to DEV can be counted.`);
    }
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");

    const reservation = capability.reserve(deadline?.remainingMs());
    if (!reservation.ok) return this.refusal(reservation.code, reservation.message);

    const started = Date.now();
    let status: RunSpecStatus = RUN_SPEC_STATUS.ERROR;
    let tests: RunSpecTestReport[] = [];
    let devWrites = 0;
    let note: string | undefined;
    let sessionLost = false;
    try {
      const outcome = await this.deps.lock.withLock(this.deps.account, () => this.executeAndClean(rel, grep, reservation.namespace, reservation.timeoutMs, stop), stop);
      status = outcome.status;
      tests = outcome.tests;
      devWrites = outcome.devWrites;
      note = outcome.note;
      sessionLost = outcome.sessionLost === true;
      /* The ledger names the bytes that ran. The file is the agent's to change while the call is out, so what it holds now is read again: a pass is recorded only for a file that is still the one hashed before the run. */
      if (this.sha256Now(rel) !== sha256) {
        if (status === RUN_SPEC_STATUS.PASSED) status = RUN_SPEC_STATUS.ERROR;
        note = [note, "the spec changed while the call ran, so this result is not recorded as a pass of the file as it stands now; run it again"].filter((n) => n !== undefined).join("; ");
      }
    } catch (err) {
      console.error(`[qa] run_spec call ${reservation.callNumber} failed in the harness: ${err instanceof Error ? err.message : String(err)}`);
      note = "the call could not be completed by the harness; nothing was reported by the spec";
    } finally {
      capability.settle({ path: rel, sha256, status, ms: Date.now() - started, devWrites });
    }
    return { ok: true, report: { status, tests, budget: capability.budget(deadline?.remainingMs()), ...(note !== undefined ? { note } : {}), ...(sessionLost ? { sessionLost: true as const } : {}) } };
  }

  private async executeAndClean(rel: string, grep: string | undefined, namespace: string, timeoutMs: number, stop: AbortSignal | undefined): Promise<{ status: RunSpecStatus; tests: RunSpecTestReport[]; devWrites: number; note?: string; sessionLost?: boolean }> {
    let result: SpecExecutionResult | undefined;
    let failure: string | undefined;
    try {
      result = await this.deps.executor.execute({ specFile: rel, namespace, timeoutMs, ...(grep !== undefined ? { grep } : {}), ...(stop ? { signal: stop } : {}) });
    } catch (err) {
      console.error(`[qa] run_spec execution failed (${namespace}): ${err instanceof Error ? err.message : String(err)}`);
      failure = "the spec could not be run";
    }
    try {
      await this.deps.cleanup.cleanup(namespace, this.deps.signal);
    } catch (err) {
      console.warn(`[qa] run_spec cleanup of ${namespace} failed (best effort): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result === undefined) return { status: RUN_SPEC_STATUS.ERROR, tests: [], devWrites: 0, note: failure ?? "the spec could not be run" };

    const tests = result.cases.slice(0, MAX_REPORTED_TESTS).map((c) => this.testReport(c));
    const status = this.statusOf(result);
    const notes: string[] = [];
    if (status === RUN_SPEC_STATUS.TIMED_OUT) notes.push(`the spec did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`);
    if (status === RUN_SPEC_STATUS.ERROR) notes.push(result.cases.length === 0 ? "no test ran: check the path and the grep" : "the run ended without a result");
    if (result.cases.length > MAX_REPORTED_TESTS) notes.push(`only the first ${MAX_REPORTED_TESTS} of ${result.cases.length} tests are listed`);
    let sessionLost = false;
    if (status !== RUN_SPEC_STATUS.PASSED && endedOnLoginWall(result.cases)) {
      /* The renewal port decides whether a sign-in may run at all: it never runs a login the agent wrote, and it is bounded (see trusted-session-renewal.ts). Without one, or when it declines, the session is lost for the rest of the loop. */
      const renewed = this.deps.session ? await this.renew() : false;
      if (renewed) notes.push("the saved session had expired and was renewed; run the spec again");
      else {
        sessionLost = true;
        notes.push("session lost: the saved session ended on the login page and cannot be renewed from here, since the app's login script is not run while you author; these results say nothing about the spec, and the run's own login phase renews the session");
      }
    }
    /* A run whose writes could not be counted (an older fixtures file, a ledger the child spoiled or never left, a run that was stopped) is charged the whole budget that was left: the count comes from the suite's own fixtures, which is code the agent can edit, so an absent or unbelievable count is never read as "none". */
    if (result.devWrites === undefined) notes.push("the requests it sent to DEV could not be counted; the whole write budget that was left was charged");
    return { status, tests, devWrites: result.devWrites ?? this.deps.capability.budget(this.deps.deadline?.remainingMs()).devWritesLeft, ...(notes.length > 0 ? { note: notes.join("; ") } : {}), ...(sessionLost ? { sessionLost } : {}) };
  }

  /* The sha256 of the spec as it stands now, read strictly, or undefined when it is gone or cannot be read. */
  private sha256Now(rel: string): string | undefined {
    try {
      const read = readOwnedSpecFile(this.deps.specRoot, rel, MAX_SPEC_SOURCE_BYTES);
      return "bytes" in read ? createHash("sha256").update(read.bytes).digest("hex") : undefined;
    } catch {
      return undefined;
    }
  }

  private async renew(): Promise<boolean> {
    try {
      return await this.deps.session!.renew(this.deps.signal);
    } catch (err) {
      console.error(`[qa] run_spec session renewal failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private statusOf(result: SpecExecutionResult): RunSpecStatus {
    if (result.verdict === "pass" && result.cases.length > 0) return RUN_SPEC_STATUS.PASSED;
    if (result.verdict === "fail" || result.verdict === "flaky") return RUN_SPEC_STATUS.FAILED;
    if (result.verdict === "infra-error" && /timed out after/i.test(result.logs)) return RUN_SPEC_STATUS.TIMED_OUT;
    return RUN_SPEC_STATUS.ERROR;
  }

  private testReport(c: QaCase): RunSpecTestReport {
    const redact = this.deps.redact;
    const failed = c.status !== "pass";
    return {
      title: cut(redact(c.name), MAX_TITLE_CHARS),
      status: failed ? "failed" : "passed",
      ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
      ...(failed && c.detail !== undefined ? { error: { message: cut(redact(c.detail.replace(ANSI, "")), MAX_ERROR_CHARS) } } : {}),
      ...(failed && c.failureDom !== undefined ? { failureDom: cut(redact(c.failureDom), MAX_FAILURE_DOM_CHARS) } : {}),
      ...(failed && c.finalUrl !== undefined ? { finalUrl: redact(withoutQuery(c.finalUrl)) } : {}),
    };
  }

  private refusal(code: RunSpecRefusalCode, message: string): RunSpecResponse {
    return { ok: false, code, message, budget: this.deps.capability.budget(this.deps.deadline?.remainingMs()) };
  }

  /* The spec's path relative to the spec directory, or why it is not one of this suite's specs. */
  private confinedPath(reported: unknown): string | { message: string } {
    if (typeof reported !== "string" || reported.trim() === "") return { message: "path must name a .spec.ts file under the e2e directory" };
    const normalized = normalizeSpecPath(reported.trim());
    if (normalized.startsWith("/")) return { message: "path must be relative to the repository" };
    if (normalized.split("/").includes("..")) return { message: "path must stay inside the e2e directory" };
    const prefix = `${this.deps.specRelDir}/`;
    const rel = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    if (rel.startsWith("-") || !SPEC_PATH_PATTERN.test(rel)) return { message: "path must be a .spec.ts file whose name uses letters, digits, dots, dashes and slashes" };
    const segments = rel.split("/");
    if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s)) || /(^|\/)auth\.setup\./.test(rel)) return { message: "path is not one of the suite's specs" };
    return rel;
  }

  private grepOf(grep: unknown): string | undefined | { message: string } {
    if (grep === undefined || grep === null || grep === "") return undefined;
    if (typeof grep !== "string" || grep.length > MAX_GREP_CHARS) return { message: `grep must be a title fragment of at most ${MAX_GREP_CHARS} characters` };
    return escapeGrep(grep);
  }
}
