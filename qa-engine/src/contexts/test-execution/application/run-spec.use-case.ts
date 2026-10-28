/*
 * One `run_spec` call: the generator asks to execute a spec it wrote, the orchestrator decides whether it may, runs it once
 * in the sandbox against DEV under a namespace of its own, cleans what it created, and answers with a bounded, redacted
 * report. Nothing the generator controls decides a limit: the path is confined to this suite's spec files, the number of
 * calls, their time and the writes they may send to DEV are counted here, and the answer never carries raw process output.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { createHash } from "node:crypto";
import { MAX_SPEC_SOURCE_BYTES, type SpecFilesPort, type SpecRoot } from "@kernel/ports/spec-files.port.ts";
import { dropOpaqueTokens } from "../domain/output-token-filter.ts";
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { failureUnsettled, type QaCase } from "@kernel/qa-case.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { stripAnsi } from "@kernel/ansi.ts";
import type { AccountLock } from "../domain/account-lock.ts";
import { endedOnLoginWall } from "../domain/login-wall.ts";
import {
  RUN_SPEC_STATUS,
  type CallBudget,
  type ClosedLoopRefusalCode,
  type RunSpecCapability,
  type RunSpecFailureFact,
  type RunSpecStatus,
} from "../domain/run-spec-capability.ts";
import type { SessionRenewalPort } from "./ports/session-renewal.port.ts";
import type { SpecCleanupPort } from "./ports/spec-cleanup.port.ts";
import type { SpecFixturesCheckPort } from "./ports/spec-fixtures-check.port.ts";
import type { SpecExecutionResult } from "../domain/spec-executor.ts";
import { isSuiteRelative, type SpecLoadError } from "../domain/spec-load-error.ts";
import { describeDevWriteRequest, type DevWriteRequest } from "../domain/dev-write-request.ts";
import type { SpecExecutorPort } from "./ports/spec-executor.port.ts";

export const MAX_GREP_CHARS = 200;
export const MAX_ERROR_CHARS = 2_000;
export const MAX_FAILURE_DOM_CHARS = 8_000;
export const MAX_TITLE_CHARS = 160;
/* How many of a spec's load errors an answer lists; the rest are counted. */
export const MAX_REPORTED_LOAD_ERRORS = 5;
export const MAX_REPORTED_TESTS = 20;
/* What a failure fact keeps of the runtime errors its page raised. */
export const MAX_FACT_RUNTIME_ERRORS = 5;
export const MAX_FACT_TEXT_CHARS = 300;
/* How exactly a failing test's time is told: a duration to the millisecond is a number the spec chooses by sleeping. */
export const DURATION_GRANULARITY_MS = 1_000;

/* The same shape the Playwright runner insists on for a spec file it is handed (e2e-execution.runner.ts SPEC_FILE_RE); a test keeps the two equal. */
export const SPEC_PATH_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.spec\.ts$/;

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", ".auth", ".qa", ".git", "test-results"]);

export const RUN_SPEC_INVALID = {
  INVALID_REQUEST: "invalid-request",
  NOT_FOUND: "not-found",
} as const;

export type RunSpecRefusalCode = ClosedLoopRefusalCode | (typeof RUN_SPEC_INVALID)[keyof typeof RUN_SPEC_INVALID];

/* Where a call tells its trace what it learned (the span the orchestrator opened for it). Total: a fault in it never reaches the call. */
export interface CallObserver {
  setAttrs(attrs: Attrs): void;
}

export interface RunSpecRequest {
  sessionId: string;
  agent: string;
  /* The assistant message the tool reported; it only joins this call to the agent's own span of it. */
  messageId?: string;
  path: string;
  grep?: string;
}

export interface RunSpecTestReport {
  title: string;
  /* Only a test that did not pass is listed: a passing test's title is the generator's own, and a title is text a spec can compute (see docs/execution-sandbox.md). */
  status: "failed";
  durationMs?: number;
  error?: { message: string };
  failureDom?: string;
  finalUrl?: string;
}

/* One reason the spec did not load, as the generator may read it. */
export interface RunSpecLoadError {
  message: string;
  /* `e2e/flows/x.spec.ts:12:5`: the suite's own path, never the host's. Absent when the report placed the error nowhere inside the suite. */
  location?: string;
}

export interface RunSpecReport {
  status: RunSpecStatus;
  /* The tests that did not pass, at most MAX_REPORTED_TESTS. */
  tests: RunSpecTestReport[];
  /* How many tests passed. */
  passedTests: number;
  budget: CallBudget;
  /* Why the spec did not load, at most MAX_REPORTED_LOAD_ERRORS: present only when no test began and the report named load errors. Read from the report's top-level errors, never from process output. */
  loadErrors?: RunSpecLoadError[];
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
  specFiles: SpecFilesPort;
  /* Judges whether a spec takes its `test` from the suite's fixtures. */
  fixtures: SpecFixturesCheckPort;
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
  /* Which specs, by path relative to the spec directory, a call may run. Absent: any spec of the suite. A flow of a plan may run its own spec and no other. */
  allowPath?: (rel: string) => boolean;
  /* What the refusal says when `allowPath` declines a spec. */
  allowedDescription?: string;
  signal?: AbortSignal;
  /* The clock the wait for the account is measured on. Default: the system clock. */
  now?: () => number;
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

function pathnameOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

export class RunSpecUseCase {
  constructor(private readonly deps: RunSpecDeps) {}

  /* `callSignal` is this call's own cancellation (its generator session ended); the run's cancellation (`deps.signal`) stops it too. */
  async run(request: RunSpecRequest, callSignal?: AbortSignal, observe?: CallObserver): Promise<RunSpecResponse> {
    const { capability, deadline } = this.deps;
    const tell = (attrs: Attrs): void => {
      try {
        observe?.setAttrs(attrs);
      } catch {
        /* observing never changes the call */
      }
    };
    const stop = callSignal && this.deps.signal ? AbortSignal.any([callSignal, this.deps.signal]) : (callSignal ?? this.deps.signal);
    const refused = capability.authorize(request.sessionId, request.agent);
    if (refused) return this.refusal(refused.code, refused.message);

    const rel = this.confinedPath(request.path);
    if (typeof rel !== "string") return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, rel.message);
    tell({ "qayaba.spec.path": rel });
    if (this.deps.allowPath && !this.deps.allowPath(rel)) {
      return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, `run_spec may run only ${this.deps.allowedDescription ?? "the spec you were given"}`);
    }
    const grep = this.grepOf(request.grep);
    if (typeof grep === "object") return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, grep.message);

    const read = this.deps.specFiles.readOwned(this.deps.specRoot, rel, MAX_SPEC_SOURCE_BYTES);
    if ("absent" in read) return this.refusal(RUN_SPEC_INVALID.NOT_FOUND, `spec not found: ${rel}. Write it under the e2e directory first.`);
    if ("reason" in read) return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, `${rel} cannot be used: ${read.reason}`);
    const source = read.bytes.toString("utf8");
    if (!this.deps.fixtures.importsTestFromFixtures(source)) {
      return this.refusal(RUN_SPEC_INVALID.INVALID_REQUEST, `${rel} must import test from the suite's fixtures file (for example: import { test, expect } from "./fixtures"), so that its requests to DEV can be counted.`);
    }
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    tell({ "qayaba.spec.sha256": sha256 });

    const reservation = capability.reserve(deadline?.remainingMs());
    if (!reservation.ok) return this.refusal(reservation.code, reservation.message);
    tell({ "qayaba.namespace": reservation.namespace });

    const started = Date.now();
    /* Whether the call got the account and began: one that did not is given back, not spent. */
    let began = false;
    let status: RunSpecStatus = RUN_SPEC_STATUS.ERROR;
    let tests: RunSpecTestReport[] = [];
    let passedTests = 0;
    let devWrites = 0;
    let devWriteRequests: readonly DevWriteRequest[] = [];
    let sessionRequests: readonly DevWriteRequest[] = [];
    let failures: RunSpecFailureFact[] = [];
    let note: string | undefined;
    let loadErrors: RunSpecLoadError[] = [];
    let sessionLost = false;
    const now = this.deps.now ?? Date.now;
    const asked = now();
    let waited = false;
    try {
      const outcome = await this.deps.lock.withLock(
        this.deps.account,
        async () => {
          waited = true;
          tell({ "qayaba.lease.wait_ms": Math.max(0, now() - asked) });
          /* The time the run has left and its writes to DEV are read when the call gets the account, not when it asked for it: every run_spec call of the run holds this lease, so the check and the charge below admit no two calls against the same last write. */
          const spent = capability.runWritesSpent();
          if (spent) return spent;
          const timeoutMs = capability.timeoutFor(deadline?.remainingMs());
          if (typeof timeoutMs !== "number") return timeoutMs;
          began = true;
          const ran = await this.executeAndClean(rel, grep, reservation.namespace, timeoutMs, stop);
          if (ran.writesUncounted) capability.chargeRunRemainder();
          else capability.chargeRunWrites(ran.devWrites);
          return ran;
        },
        stop,
      );
      if ("ok" in outcome) return this.refusal(outcome.code, outcome.message);
      status = outcome.status;
      tests = outcome.tests;
      passedTests = outcome.passedTests;
      devWrites = outcome.devWrites;
      devWriteRequests = outcome.devWriteRequests ?? [];
      sessionRequests = outcome.sessionRequests ?? [];
      failures = outcome.failures;
      note = outcome.note;
      loadErrors = outcome.loadErrors ?? [];
      sessionLost = outcome.sessionLost === true;
      tell({ "qayaba.tool.dev_writes": devWrites });
      if (devWriteRequests.length > 0) tell({ "qayaba.tool.dev_write_requests": devWriteRequests.map(describeDevWriteRequest) });
      if (sessionRequests.length > 0) tell({ "qayaba.tool.dev_session_requests": sessionRequests.map(describeDevWriteRequest) });
      /* The ledger names the bytes that ran. The file is the agent's to change while the call is out, so what it holds now is read again: a pass is recorded only for a file that is still the one hashed before the run. */
      if (this.sha256Now(rel) !== sha256) {
        if (status === RUN_SPEC_STATUS.PASSED) status = RUN_SPEC_STATUS.ERROR;
        note = [note, "the spec changed while the call ran, so this result is not recorded as a pass of the file as it stands now; run it again"].filter((n) => n !== undefined).join("; ");
      }
    } catch (err) {
      engineLog.error(`[qa] run_spec call ${reservation.callNumber} failed in the harness: ${err instanceof Error ? err.message : String(err)}`);
      note = "the call could not be completed by the harness; nothing was reported by the spec";
    } finally {
      if (!waited) tell({ "qayaba.lease.wait_ms": Math.max(0, now() - asked) });
      if (began) capability.settle({ path: rel, sha256, status, ms: Date.now() - started, devWrites, ...(devWriteRequests.length > 0 ? { devWriteRequests } : {}), ...(failures.length > 0 ? { failures } : {}) });
      else capability.cancel();
    }
    return { ok: true, report: { status, tests, passedTests, budget: capability.budget(deadline?.remainingMs()), ...(loadErrors.length > 0 ? { loadErrors } : {}), ...(note !== undefined ? { note } : {}), ...(sessionLost ? { sessionLost: true as const } : {}) } };
  }

  private async executeAndClean(rel: string, grep: string | undefined, namespace: string, timeoutMs: number, stop: AbortSignal | undefined): Promise<{ status: RunSpecStatus; tests: RunSpecTestReport[]; passedTests: number; devWrites: number; devWriteRequests?: readonly DevWriteRequest[]; sessionRequests?: readonly DevWriteRequest[]; writesUncounted?: true; failures: RunSpecFailureFact[]; loadErrors?: RunSpecLoadError[]; note?: string; sessionLost?: boolean }> {
    let result: SpecExecutionResult | undefined;
    let failure: string | undefined;
    try {
      result = await this.deps.executor.execute({ specFile: rel, namespace, timeoutMs, ...(grep !== undefined ? { grep } : {}), ...(stop ? { signal: stop } : {}) });
    } catch (err) {
      engineLog.error(`[qa] run_spec execution failed (${namespace}): ${err instanceof Error ? err.message : String(err)}`);
      failure = "the spec could not be run";
    }
    try {
      await this.deps.cleanup.cleanup(namespace, this.deps.signal);
    } catch (err) {
      engineLog.warn(`[qa] run_spec cleanup of ${namespace} failed (best effort): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result === undefined) return { status: RUN_SPEC_STATUS.ERROR, tests: [], passedTests: 0, devWrites: 0, failures: [], note: failure ?? "the spec could not be run" };

    const failing = result.cases.filter((c) => c.status !== "pass");
    const passedTests = result.cases.length - failing.length;
    const failures = failing.slice(0, MAX_REPORTED_TESTS).map((c) => this.failureFact(c));
    const tests = failing.slice(0, MAX_REPORTED_TESTS).map((c) => this.testReport(c));
    const status = this.statusOf(result);
    const notes: string[] = [];
    if (status === RUN_SPEC_STATUS.TIMED_OUT) notes.push(`the spec did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`);
    /* A report that holds no test but names load errors says why: the spec did not load, which is neither a wrong path nor a grep that matched nothing. */
    const loadErrors = result.cases.length === 0 ? this.loadErrorFacts(result.loadErrors ?? []) : [];
    const loadErrorCount = result.cases.length === 0 ? (result.loadErrors ?? []).length : 0;
    if (status === RUN_SPEC_STATUS.ERROR) {
      if (result.cases.length > 0) notes.push("the run ended without a result");
      else if (loadErrorCount > 0) notes.push("the spec did not load, so no test ran: fix the errors in loadErrors, then run it again");
      else notes.push("no test ran: check the path and the grep");
    }
    if (loadErrorCount > loadErrors.length) notes.push(`only the first ${loadErrors.length} of ${loadErrorCount} load errors are listed`);
    if (failing.length > MAX_REPORTED_TESTS) notes.push(`only the first ${MAX_REPORTED_TESTS} of ${failing.length} failing tests are listed`);
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
    else if (result.unfinishedTests !== undefined && result.unfinishedTests > 0) notes.push(`${result.unfinishedTests} test(s) had not finished when the call ended; the writes they had sent and the requests they still had out were counted`);
    return { status, tests, passedTests, devWrites: result.devWrites ?? this.deps.capability.budget(this.deps.deadline?.remainingMs()).devWritesLeft, ...(result.devWrites === undefined ? { writesUncounted: true as const } : {}), ...(result.devWrites !== undefined && result.devWriteRequests !== undefined ? { devWriteRequests: result.devWriteRequests } : {}), ...(result.devWrites !== undefined && result.sessionRequests !== undefined ? { sessionRequests: result.sessionRequests } : {}), failures, ...(loadErrors.length > 0 ? { loadErrors } : {}), ...(notes.length > 0 ? { note: notes.join("; ") } : {}), ...(sessionLost ? { sessionLost } : {}) };
  }

  /* The sha256 of the spec as it stands now, read strictly, or undefined when it is gone or cannot be read. */
  private sha256Now(rel: string): string | undefined {
    try {
      const read = this.deps.specFiles.readOwned(this.deps.specRoot, rel, MAX_SPEC_SOURCE_BYTES);
      return "bytes" in read ? createHash("sha256").update(read.bytes).digest("hex") : undefined;
    } catch {
      return undefined;
    }
  }

  private async renew(): Promise<boolean> {
    try {
      return await this.deps.session!.renew(this.deps.signal);
    } catch (err) {
      engineLog.error(`[qa] run_spec session renewal failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private statusOf(result: SpecExecutionResult): RunSpecStatus {
    if (result.verdict === "pass" && result.cases.length > 0) return RUN_SPEC_STATUS.PASSED;
    if (result.verdict === "fail" || result.verdict === "flaky") return RUN_SPEC_STATUS.FAILED;
    if (result.verdict === "infra-error" && /timed out after/i.test(result.logs)) return RUN_SPEC_STATUS.TIMED_OUT;
    return RUN_SPEC_STATUS.ERROR;
  }

  /* Everything a spec can write into a test's title, error or final address passes the run's by-value redaction (the secrets it holds, in each encoding it could print them in) and then the long-token filter. */
  /* The facts a failure is classified from, kept for the orchestrator: text the spec can influence is redacted and bounded like the report's. */
  private failureFact(c: QaCase): RunSpecFailureFact {
    const path = pathnameOf(c.finalUrl);
    const runtimeErrors = (c.runtimeErrors ?? []).slice(0, MAX_FACT_RUNTIME_ERRORS).map((e) => ({ type: e.type, text: cut(this.deps.redact(e.text), MAX_FACT_TEXT_CHARS) }));
    return {
      ...(c.detail !== undefined ? { detail: cut(this.deps.redact(stripAnsi(c.detail)), MAX_ERROR_CHARS) } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(c.failureResultCount !== undefined ? { resultCount: c.failureResultCount } : {}),
      ...(c.httpStatus !== undefined ? { httpStatus: c.httpStatus } : {}),
      ...(runtimeErrors.length > 0 ? { runtimeErrors } : {}),
      ...(failureUnsettled(c.failureSettle) ? { unsettled: true as const } : {}),
    };
  }

  /* The load errors the report named, as facts the generator may read. They come from the report the child wrote, so they are held to the bounds of a case's error: the run's secrets by value and by pattern, no terminal colors, no long opaque token, no host path (the suite's own roots are taken off the text, and a location that is not inside the suite is dropped), at most MAX_REPORTED_LOAD_ERRORS of them and MAX_ERROR_CHARS each. */
  private loadErrorFacts(errors: readonly SpecLoadError[]): RunSpecLoadError[] {
    const { specDir, mirrorDir } = this.deps.specRoot;
    const withoutRoots = (text: string): string => [specDir, mirrorDir].reduce((acc, root) => acc.split(`${root.replace(/\/+$/, "")}/`).join(""), text);
    return errors.slice(0, MAX_REPORTED_LOAD_ERRORS).map((e) => {
      const file = e.location?.file;
      const inside = file !== undefined && isSuiteRelative(file);
      const place = inside ? `${this.deps.specRelDir}/${this.deps.redact(file)}${e.location?.line !== undefined ? `:${e.location.line}${e.location.column !== undefined ? `:${e.location.column}` : ""}` : ""}` : undefined;
      return {
        message: cut(dropOpaqueTokens(this.deps.redact(stripAnsi(withoutRoots(e.message))), ""), MAX_ERROR_CHARS),
        ...(place !== undefined ? { location: place } : {}),
      };
    });
  }

  private testReport(c: QaCase): RunSpecTestReport {
    /* What the page showed at this test's failure point: a token that is in it is one the generator can read there, so the filter leaves it alone. */
    const shown = c.failureDom === undefined ? "" : this.deps.redact(c.failureDom);
    const clean = (text: string): string => dropOpaqueTokens(this.deps.redact(text), shown);
    return {
      title: cut(clean(c.name), MAX_TITLE_CHARS),
      status: "failed",
      ...(c.durationMs !== undefined ? { durationMs: Math.round(c.durationMs / DURATION_GRANULARITY_MS) * DURATION_GRANULARITY_MS } : {}),
      ...(c.detail !== undefined ? { error: { message: cut(clean(stripAnsi(c.detail)), MAX_ERROR_CHARS) } } : {}),
      ...(c.failureDom !== undefined ? { failureDom: cut(this.deps.redact(c.failureDom), MAX_FAILURE_DOM_CHARS) } : {}),
      ...(c.finalUrl !== undefined ? { finalUrl: clean(withoutQuery(c.finalUrl)) } : {}),
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
