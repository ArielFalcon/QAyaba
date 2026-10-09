/* E2E Playwright runner against live DEV. Timeouts and recordAudit are injected — this module never reads process.env and never imports src/orchestrator. */

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { QaCase, CaseStatus } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { sanitizeText, type SecretDetection } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { parseAriaSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { BoundedLineReader } from "@kernel/process-sandbox/bounded-line-reader.ts";
import { BoundedOutputTail } from "@kernel/process-sandbox/bounded-output-tail.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import { authSessionEnv } from "../../../shared-infrastructure/process-sandbox/auth-session-env.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { describeReasons, scanRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";
import { readFailureReason, readOwnedSpecFile, type OwnedSpecRead } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { parsePlaywrightReport } from "./playwright-report.ts";
import { PLAYWRIGHT_INFRA_RE } from "../domain/playwright-infra.ts";

export const DEFAULT_E2E_TIMEOUT_MS = 900_000;

export const DEFAULT_CLEANUP_TIMEOUT_MS = 300_000;

/* What is kept of a Playwright run's stderr: enough for any real run's log, bounded because the specs are agent-written code and may write without limit. */
export const E2E_STDERR_KEEP_CHARS = 500_000;

/* A stream event is one small JSON object on one line; a longer line is not an event and is skipped instead of buffered. */
export const MAX_STREAM_EVENT_LINE_CHARS = 65_536;

/** Resolves the effective e2e timeout: env.QA_E2E_TIMEOUT_MS when set to a positive number of milliseconds, the default otherwise. `env` is REQUIRED (no default) — the caller (the composition-root shell) must read process.env and pass it in once per composition; see this file's header for why (mirrors sandbox.ts's resolveSandbox(env, ...) precedent exactly). */
export function e2eTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.QA_E2E_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_E2E_TIMEOUT_MS;
}

export const PW_PROJECT_RE = /^[A-Za-z0-9_-]+$/;

export const SPEC_FILE_RE = /^[A-Za-z0-9._/-]+\.spec\.ts$/;

function assertSpecFiles(specFiles: string[]): void {
  for (const f of specFiles) {
    if (f.startsWith("-")) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: must not start with "-"`);
    }
    if (f.includes("../")) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: path traversal not allowed`);
    }
    if (!SPEC_FILE_RE.test(f)) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: must match ${String(SPEC_FILE_RE)}`);
    }
  }
}

export interface E2eExecuteOptions {
  baseUrl: string;
  namespace: string;
  onCase?: (c: QaCase) => void;
  onRunning?: (title: string) => void;
  onDiscovered?: (title: string, file?: string) => void;
  faultInject?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  project?: string;
  testIdAttribute?: string;
  specFiles?: string[];
}

export type StreamEvent =
  | { phase: "begin"; total: number }
  | { phase: "discovered"; title: string; file?: string }
  | { phase: "testbegin"; title: string; file?: string }
  | { phase: "testend"; title: string; status: string; durationMs?: number };

export function parseStreamEvent(line: string): StreamEvent | null {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  let obj: { e?: string; total?: number; title?: string; file?: string; status?: string; d?: number };
  try { obj = JSON.parse(s); } catch { return null; }
  if (obj.e === "begin" && typeof obj.total === "number") return { phase: "begin", total: obj.total };
  if (obj.e === "discovered" && typeof obj.title === "string") return { phase: "discovered", title: obj.title, ...(obj.file ? { file: String(obj.file) } : {}) };
  if (obj.e === "testbegin" && typeof obj.title === "string") return { phase: "testbegin", title: obj.title, ...(obj.file ? { file: String(obj.file) } : {}) };
  if (obj.e === "testend" && typeof obj.title === "string") return { phase: "testend", title: obj.title, status: String(obj.status ?? ""), ...(typeof obj.d === "number" ? { durationMs: obj.d } : {}) };
  return null;
}

/** Maps a Playwright per-attempt status to our case status. `skipped` did not execute → not a case. Anything not clearly green is fail-closed (never a silent pass). */
export function streamStatusToCase(status: string): CaseStatus | null {
  if (status === "passed" || status === "expected") return "pass";
  if (status === "skipped") return null;
  return "fail";
}

/*
 * Pattern owner: test-execution/domain/playwright-infra.ts. Runner-infra
 * reclassification runs HERE, upstream of both of runE2E's production callers
 * (E2eExecutionStrategy and the fault-injection oracle's own re-run) — see the call site below.
 */
export function allFailuresAreRunnerInfra(cases: QaCase[]): boolean {
  const failed = cases.filter((c) => c.status === "fail");
  return failed.length > 0 && failed.every((c) => PLAYWRIGHT_INFRA_RE.test(c.detail ?? ""));
}

export interface E2eRunOutput {
  report: unknown;
  logs: string;
  ran: boolean;
  /* How the child ended, when the runner knows: its exit status, or the signal that ended it (then there is no status). A runner that tells neither is not accused of anything. */
  exitCode?: number;
  signal?: string;
}

export interface E2eExecuteDeps {
  runSuite(args: {
    dir: string;
    baseUrl: string;
    namespace: string;
    testIdAttribute?: string;
    faultInject?: boolean;
    project?: string;
    specFiles?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    onEvent?: (ev: StreamEvent) => void;
    failureCaptureDir?: string;
  }): Promise<E2eRunOutput>;
  defaultTimeoutMs?: number;
  /* OPTIONAL diagnostic sink for a secret-redaction audit trail (src/orchestrator/sanitizer.ts's recordAudit/SECRET_AUDIT — a security-boundary concern this module does not import directly, to stay src/-free). Absent ⇒ no audit recorded (safe for every unit test that doesn't care about it). The composition-root shell (rewritten-engine-factory.ts) binds the REAL recordAudit into createDefaultE2eExecuteDeps's returned object, so production behavior is unchanged. */
  recordAudit?(runId: string, detection: SecretDetection): void;
}

/** Local result shape so this file stays src/-free. */
export interface E2eRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean;
  cases: QaCase[];
  logs: string;
  note?: string;
}

/* Why a report that says every test passed is not believed, or undefined when how the child ended gives no reason to doubt it. Both the status and the signal come from the process, never from the report or the logs, so they are safe to say. */
function untrustedExit(out: E2eRunOutput): string | undefined {
  if (out.signal !== undefined) return `the Playwright child was ended by ${out.signal} although its report says every test passed: a run that did not finish is not a pass.`;
  if (out.exitCode !== undefined && out.exitCode !== 0) return `the Playwright child exited with status ${out.exitCode} although its report says every test passed: Playwright exits with a failure status when a test failed, so the report is not believed.`;
  return undefined;
}

function isReportShaped(report: unknown): boolean {
  if (typeof report !== "object" || report === null) return false;
  const r = report as Record<string, unknown>;
  return "suites" in r || "stats" in r;
}

export async function runE2E(
  specDir: string,
  opts: E2eExecuteOptions,
  deps: E2eExecuteDeps,
): Promise<E2eRunResult> {
  if (opts.project !== undefined && !PW_PROJECT_RE.test(opts.project)) {
    throw new Error(`invalid Playwright project name ${JSON.stringify(opts.project)}: must match ${String(PW_PROJECT_RE)}`);
  }

  if (opts.signal?.aborted) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: "e2e run aborted by operator cancel before the runner started",
    };
  }

  const onEvent = (opts.onCase || opts.onRunning || opts.onDiscovered)
    ? (ev: StreamEvent): void => {
        if (ev.phase === "discovered") opts.onDiscovered?.(ev.title, ev.file);
        else if (ev.phase === "testbegin") opts.onRunning?.(ev.title);
        else if (ev.phase === "testend") {
          const st = streamStatusToCase(ev.status);
          if (st) opts.onCase?.({ name: ev.title, status: st, ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}) });
        }
      }
    : undefined;

  let failureCaptureDir: string | undefined;
  try { failureCaptureDir = mkdtempSync(join(tmpdir(), "qa-fail-")); } catch { /* no-op */ }

  try {
  const runPromise = deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
    faultInject: opts.faultInject,
    /* No project unless one is configured: the repo owns its playwright.config.ts, so every project it defines runs. The seed keeps its login setup project out of a suite run itself (it is defined only under PW_AUTH_SETUP). */
    project: opts.project,
    testIdAttribute: opts.testIdAttribute,
    specFiles: opts.specFiles,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onEvent,
    failureCaptureDir,
  });

  const timeoutMs = opts.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_E2E_TIMEOUT_MS;
  const timedOut: E2eRunOutput = { report: {}, logs: `playwright runner timed out after ${timeoutMs}ms — killed`, ran: false };
  const abortedOut: E2eRunOutput = { report: {}, logs: "playwright runner aborted by operator cancel — killed", ran: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const racers: Array<Promise<E2eRunOutput>> = [
    runPromise,
    new Promise<E2eRunOutput>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); }),
  ];
  if (opts.signal) {
    racers.push(new Promise<E2eRunOutput>((resolve) => {
      onAbort = () => resolve(abortedOut);
      opts.signal!.addEventListener("abort", onAbort, { once: true });
    }));
  }

  let out: E2eRunOutput;
  try {
    out = await Promise.race(racers);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
  const { report, logs, ran } = out;

  /* Single sanitizeText pass: a separate containsSecrets() pre-check is redundant with this SAME detection result (mirrors code-execution.runner.ts's own AMENDMENT-1 simplification) — the warn fires under the exact same condition as before, just derived from one call instead of two. */
  const sanitized = sanitizeText(logs);
  if (sanitized.detection.redacted) {
    console.warn("[sanitizer] Secrets detected in E2E execution logs — redacting before publish");
  }
  deps.recordAudit?.(opts.namespace, sanitized.detection);

  /* The temp capture dir is removed on EVERY exit path — the early infra-error returns below, the main return, a throw from the harvest, AND a runSuite REJECT — via the finally at the end. A runner that produced no parseable report did not actually run the suite — it crashed (bad config, browser launch failure, OOM). That is INFRASTRUCTURE, not a pass: never let a swallowed parse error surface as green (the #1 invariant). */
  if (!ran || !isReportShaped(report)) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: sanitized.text || "the E2E runner produced no report (it crashed before reporting results)",
    };
  }

  const parsed = parsePlaywrightReport(report);

  if (parsed.executed === 0) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: parsed.cases,
      logs: sanitized.text || "the E2E suite ran but executed zero tests (no tests matched, or all were skipped)",
    };
  }

  /* The report is written by the test process, so a report that says every test passed cannot be told from a forged one by what it holds. How the child ended can: Playwright exits with a failure status when a test failed, and a child that a signal ended never finished reporting. A pass that the child did not exit 0 for is a run that cannot be trusted: infrastructure, and none of its cases is handed on. A failure stays a failure whatever the status; the status only takes a pass away. */
  const distrust = parsed.verdict === "pass" ? untrustedExit(out) : undefined;
  if (distrust !== undefined) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: `${sanitized.text}\n[qa] ${distrust}`.trim(),
      note: distrust,
    };
  }

  if (parsed.verdict === "fail" && allFailuresAreRunnerInfra(parsed.cases)) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: parsed.cases,
      logs: sanitized.text,
      note: "Playwright could not launch the browser — runner infrastructure fault, not a test failure. Check the browser install / PLAYWRIGHT_BROWSERS_PATH.",
    };
  }

  /* Post-run harvest: for each failed case, read the aria snapshot dump written by the qa-failure-capture afterEach fixture and populate QaCase.failureDom. The pipeline splits this back into lines without re-parsing. The fixture dump is the ONLY source — Playwright's JSON reporter carries no per-error DOM snapshot to fall back to (JSONReportError is just {message, location?}). LOUD WARNING when a failed case yields no dump — this is a grounding gap (invariant: never swallow, per CLAUDE.md). Post-run harvest over PwCase[] (before widening to QaCase[]): we mutate the same objects (same references) — the cast to QaCase[] below picks up the failureDom we set here because the runtime objects are identical. */
  const failedPwCases = parsed.cases.filter((c) => c.status === "fail");
  if (failedPwCases.length > 0) {
    /* The per-case harvest runs whenever there are failed cases — NOT gated on failureCaptureDir. When the dir is absent (e.g. mkdtempSync failed for lack of /tmp space) `dumps` is simply [] and every failed case falls straight to the loud "no grounding captured" WARNING below. Gating the whole loop on the dir silently dropped the WARNING — violating the never-swallow invariant. Read every dump ONCE into {file, title, retry, yaml}: matching keys off the dump's own `file` + `title` (the describe›test chain the fixture wrote), which the report's case name ENDS WITH — the report prepends the spec file as the top suite, the fixture records it as a separate `file`. */
    const dumps = failureCaptureDir ? readFailureDumps(failureCaptureDir) : [];
    for (const c of failedPwCases) {
      const qa = c as unknown as QaCase;
      const dump = matchFailureDumps(c.name, dumps);
      if (dump?.yaml) {
        const nodes = parseAriaSnapshot(dump.yaml);
        if (nodes.length > 0) qa.failureDom = nodes.join("\n");
      }
      if (dump?.httpStatus !== undefined) qa.httpStatus = dump.httpStatus;
      if (dump?.finalUrl !== undefined) qa.finalUrl = dump.finalUrl;
      if (dump?.runtimeErrors !== undefined) qa.runtimeErrors = dump.runtimeErrors;
      /* No dump (or an unparseable one): loud WARNING (grounding gap — never swallow). */
      if (!qa.failureDom) {
        console.warn(`[qa] WARNING: no failure-point DOM captured for failed case ${JSON.stringify(c.name)} (no fixture dump) — fix-loop will run without grounding.`);
      }
    }
  }

  const qaCases = parsed.cases as QaCase[];

  return {
    sha: opts.namespace,
    verdict: parsed.verdict,
    passed: parsed.passed,
    cases: qaCases,
    logs: sanitized.text,
  };
  } finally {
    if (failureCaptureDir) {
      try { rmSync(failureCaptureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

const TITLE_SEP = " › ";
export function titleSegments(title: string): string[] {
  return title.split(TITLE_SEP).map((s) => s.trim()).filter(Boolean);
}

export function segmentsAreTail(full: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length > full.length) return false;
  const offset = full.length - tail.length;
  for (let i = 0; i < tail.length; i++) {
    if (full[offset + i] !== tail[i]) return false;
  }
  return true;
}

export interface FailureDump {
  project: string;
  file?: string;
  title: string;
  retry: number;
  yaml?: string;
  httpStatus?: number;
  finalUrl?: string;
  runtimeErrors?: { type: string; text: string }[];
}

/* What the Playwright child leaves in the two directories this module makes for a run: the JSON report and the failure-capture dumps. The child runs the repo's specs, which are code the agent wrote, and it knows both paths, so a named pipe, a link or a file of any size can be there instead of what the reporter or the fixture wrote. Both are read through the strict read of spec-path-confinement, under these caps, which are far beyond any real run: a Playwright report holds a few kilobytes per test (a thousand tests that fail on all three attempts with a 4 KB message each make 12 MiB, and nothing real is larger), and an aria snapshot of a very large page a few megabytes. They are parsed in the orchestrator's one thread, and a document of nothing but empty arrays costs some fifteen times its size in heap and about a second of parse for every 12 MiB (one of 128 MiB took 11 s and 2 GiB), so the caps are also what a freeze or an out-of-memory can cost: at these, about a second and a quarter of a gigabyte for the report, and the same for all the dumps together. A worker thread with a heap limit would bound the heap and not the cost of handing the result back, so the smaller cap is the whole defense. */
export const MAX_PLAYWRIGHT_REPORT_BYTES = 16 * 1024 * 1024;
export const MAX_FAILURE_DUMP_BYTES = 8 * 1024 * 1024;
export const MAX_FAILURE_DUMPS_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_FAILURE_DUMP_FILES = 4_096;
export const FAILURE_DUMP_LIMITS: RunOutputLimits = {
  maxFileBytes: MAX_FAILURE_DUMP_BYTES,
  maxTotalBytes: MAX_FAILURE_DUMPS_TOTAL_BYTES,
  maxFiles: MAX_FAILURE_DUMP_FILES,
};

/* Why a report that was there is no report: said in words that quote nothing it holds, since a parser's message does. */
const REPORT_NOT_JSON = "the report is not valid JSON";

/* The report, or that the run has none: with the reason when there was a report that could not be used, and with none when there was no report at all. */
export type PlaywrightReportRead = { ran: true; report: unknown } | { ran: false; reason: string } | { ran: false };

/* The report the child left at `jsonPath`, parsed, or why there is none. A report that is not there is a run that did not report (no reason to give); one that is there and cannot be used (a link, a named pipe, a directory, one over the cap, one that cannot be read, one that is not JSON) is refused with the reason of the module's own. Either way the run has no result, which is infrastructure and never a pass. Never throws and never waits on a pipe. */
export function readPlaywrightReport(jsonPath: string, maxBytes: number = MAX_PLAYWRIGHT_REPORT_BYTES): PlaywrightReportRead {
  const dir = dirname(jsonPath);
  let read: OwnedSpecRead;
  try {
    read = readOwnedSpecFile({ mirrorDir: dir, specDir: dir }, basename(jsonPath), maxBytes);
  } catch (err) {
    return { ran: false, reason: readFailureReason(err) };
  }
  if ("absent" in read) return { ran: false };
  if ("reason" in read) return { ran: false, reason: read.reason };
  try {
    return { ran: true, report: JSON.parse(read.bytes.toString("utf8")) };
  } catch {
    return { ran: false, reason: REPORT_NOT_JSON };
  }
}

const DUMP_FILE_RE = /__(\d+)\.json$/;

/* One dump, from the file the fixture wrote. Throws on what is not JSON; the reader says that the dump was left out and never quotes why. */
function toFailureDump(name: string, bytes: Buffer): FailureDump {
  const body = JSON.parse(bytes.toString("utf8")) as { project?: unknown; file?: unknown; title?: unknown; retry?: unknown; yaml?: unknown; httpStatus?: unknown; finalUrl?: unknown; runtimeErrors?: unknown };
  const runtimeErrors = parseRuntimeErrors(body.runtimeErrors);
  return {
    project: typeof body.project === "string" ? body.project : "",
    ...(typeof body.file === "string" ? { file: body.file } : {}),
    title: typeof body.title === "string" ? body.title : "",
    retry: typeof body.retry === "number" ? body.retry : parseInt(DUMP_FILE_RE.exec(name)![1]!, 10),
    ...(typeof body.yaml === "string" ? { yaml: body.yaml } : {}),
    /* Runtime evidence (HTTP status, final URL, runtime errors) — parsed defensively: absent/garbage → undefined, never throw. */
    ...(typeof body.httpStatus === "number" && Number.isInteger(body.httpStatus) ? { httpStatus: body.httpStatus } : {}),
    ...(typeof body.finalUrl === "string" ? { finalUrl: body.finalUrl } : {}),
    ...(runtimeErrors.length > 0 ? { runtimeErrors } : {}),
  };
}

/* The failure-capture dumps in `dir`, in the order of their names. Each dump stands for its own failed case, so what cannot be used is left out and the rest is used: the case that lost its dump runs without grounding, which the harvest says case by case. What was left out is said once for the directory, by how many and why, naming no file (the child chooses the names) and quoting nothing a dump holds. Never throws and never waits on a pipe. */
export function readFailureDumps(dir: string, limits: RunOutputLimits = FAILURE_DUMP_LIMITS): FailureDump[] {
  const scan = scanRunOutputDir({ mirrorDir: dir, specDir: dir }, ".", (name) => DUMP_FILE_RE.test(name), toFailureDump, limits, { readCut: true });
  if ("absent" in scan) return [];
  if ("unusable" in scan) {
    console.warn(`[qa] WARNING: ${dir} was not read (${scan.unusable}); no failure capture dump is used, so every failed case runs without grounding.`);
    return [];
  }
  if (scan.cut) console.warn(`[qa] WARNING: ${dir}: more than ${limits.maxFiles} entries; only the first ${limits.maxFiles} were looked at.`);
  if (scan.leftOut.length > 0) {
    console.warn(`[qa] WARNING: ${dir}: ${scan.leftOut.length} failure capture dump(s) not read — ${describeReasons(scan.leftOut)}; the cases they would have grounded run without grounding.`);
  }
  return scan.files;
}

/* Defensively parses the `runtimeErrors` field of a capture dump: a malformed entry (wrong shape, non-string `text`/`type`) is DROPPED rather than throwing or poisoning the whole array — the fixture that writes these dumps is best-effort and self-contained (see qa-failure-capture in config/e2e/fixtures.ts), so the harvest side must tolerate a partially-garbage array. Never throws. */
function parseRuntimeErrors(v: unknown): { type: string; text: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { type: string; text: string }[] = [];
  for (const entry of v) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { type?: unknown }).type === "string" &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      out.push({ type: (entry as { type: string }).type, text: (entry as { text: string }).text });
    }
  }
  return out;
}

export function matchFailureDumps(caseName: string, dumps: FailureDump[]): FailureDump | null {
  const caseSegs = titleSegments(caseName);
  const candidates = dumps.filter((d) => {
    if (!d.title || !segmentsAreTail(caseSegs, titleSegments(d.title))) return false;
    if (d.file && !caseSegs.some((s) => s === d.file || s.endsWith(`/${d.file}`))) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : b.retry - a.retry));
  return candidates[0]!;
}

/** Runs the repo's `e2e/` project (with its own config/fixtures) with the JSON reporter. Playwright is not a dependency of this template (it would pull in browsers): it lives in the environment where the service runs (the orchestrator image is based on the Playwright image). PW_BASE_URL points to DEV; PW_NAMESPACE is the run's data prefix (read by the fixtures). Orphan-data cleanup: runs ONLY cleanup.spec.ts with PW_CLEANUP=1 and the interrupted run's namespace, so a crashed run's namespaced test data is deleted before the next run. Best-effort: it never throws and never blocks the new run (failures are warnings). */
export interface E2eCleanupDeps {
  runCleanup(args: { dir: string; baseUrl: string; namespace: string; testIdAttribute?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
}

/**
 * authDir: the orchestrator-only directory (outside the watched-repo mirror) AuthSessionAdapter
 * wrote auth material to — supplied by the composition-root shell. REQUIRED, like createCaptureDomDeps's
 * authDir: a fallback to `dir` (the watched-repo mirror, agent-visible) would silently put auth
 * material where the read-only agent can read it whenever a caller omitted the override. There is no safe default, so a caller that forgets it is a
 * TypeScript compile error, and — mirroring the same fail-closed constructor-guard pattern already
 * established for PublicationPortAdapter and createCaptureDomDeps — a caller that bypasses the type
 * system still gets an immediate, loud throw here, never a silent `dir` default.
 */
export function createDefaultE2eCleanupDeps(processKill: ProcessKillPort = new ProcessKillAdapter(), authDir: string): E2eCleanupDeps {
  if (!authDir) {
    throw new Error(
      "[qa] createDefaultE2eCleanupDeps requires authDir — there is no safe default (omitting it would silently read/write auth material under the e2e dir, the agent-visible mirror).",
    );
  }
  return {
    runCleanup: ({ dir, baseUrl, namespace, testIdAttribute, signal, timeoutMs }) =>
      new Promise((resolve) => {
        const child = spawn("npx", ["playwright", "test", "cleanup.spec.ts", "--reporter=line"], {
          cwd: dir,
          env: authSessionEnv(authDir, { ...scrubEnv({ extraAllowed: /^DEV_/ }), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PW_CLEANUP: "1", ...(testIdAttribute ? { PW_TEST_ID_ATTRIBUTE: testIdAttribute } : {}) }),
          detached: true,
          /* Nothing reads the cleanup's output. Piped and unread, it would block the child once the OS pipe buffer fills, and keep the pipes open to any descendant that outlives it. */
          stdio: "ignore",
        });
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (onAbort) signal?.removeEventListener("abort", onAbort);
          resolve(); /* best-effort: cleanup never throws and never blocks the next run */
        };
        const ms = timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
        const timer = setTimeout(() => {
          console.warn(`[qa] orphan-data cleanup timed out after ${ms}ms — killed (best-effort, continuing)`);
          processKill.killTree(child);
          settle();
        }, ms);
        const onAbort = signal
          ? () => { processKill.killTree(child); settle(); }
          : undefined;
        if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
        child.on("error", () => settle());
        child.on("close", () => settle());
      }),
  };
}

const STREAM_REPORTER = `
class QaStreamReporter {
  onBegin(_config, suite) {
    var tests = suite.allTests();
    this._w({ e: "begin", total: tests.length });
    for (var i = 0; i < tests.length; i++) this._w({ e: "discovered", title: this._name(tests[i]), file: tests[i].location && tests[i].location.file });
  }
  onTestBegin(test) { this._w({ e: "testbegin", title: this._name(test), file: test.location && test.location.file }); }
  onTestEnd(test, result) { this._w({ e: "testend", title: this._name(test), status: result.status, d: result.duration }); }
  _name(test) { return test.titlePath().filter(Boolean).slice(1).join(" \\u203a "); }
  _w(o) { try { process.stdout.write(JSON.stringify(o) + "\\n"); } catch (_e) {} }
}
module.exports = QaStreamReporter;
`;

export function playwrightArgs(reporterPath: string, project?: string, specFiles?: string[]): string[] {
  const args = ["playwright", "test", `--reporter=${reporterPath},json`];
  if (project !== undefined) {
    if (!PW_PROJECT_RE.test(project)) {
      throw new Error(`invalid Playwright project name ${JSON.stringify(project)}: must match ${String(PW_PROJECT_RE)}`);
    }
    args.push(`--project=${project}`);
  }
  if (specFiles !== undefined && specFiles.length > 0) {
    assertSpecFiles(specFiles);
    args.push(...specFiles);
  }
  return args;
}

/**
 * authDir: the orchestrator-only directory (outside the watched-repo mirror) AuthSessionAdapter
 * wrote auth material to — supplied by the composition-root shell. REQUIRED, like createCaptureDomDeps's
 * authDir: a fallback to `dir` (the watched-repo mirror, agent-visible) would silently put auth
 * material where the read-only agent can read it whenever a caller omitted the override. There is no safe default, so a caller that forgets it is a
 * TypeScript compile error, and — mirroring the same fail-closed constructor-guard pattern already
 * established for PublicationPortAdapter and createCaptureDomDeps — a caller that bypasses the type
 * system still gets an immediate, loud throw here, never a silent `dir` default. Moved ahead of the
 * optional actionTimeoutMs so a required parameter never follows an optional one.
 */
export function createDefaultE2eExecuteDeps(
  processKill: ProcessKillPort = new ProcessKillAdapter(),
  defaultTimeoutMs: number = DEFAULT_E2E_TIMEOUT_MS,
  authDir: string,
  actionTimeoutMs?: string,
  /* The read of the report the child left, a seam so that a test can see when it is made. */
  readReport: (jsonPath: string) => PlaywrightReportRead = readPlaywrightReport,
): E2eExecuteDeps {
  if (!authDir) {
    throw new Error(
      "[qa] createDefaultE2eExecuteDeps requires authDir — there is no safe default (omitting it would silently read/write auth material under the e2e dir, the agent-visible mirror).",
    );
  }
  return {
    defaultTimeoutMs,
    runSuite: ({ dir, baseUrl, namespace, testIdAttribute, faultInject, project, specFiles, signal, timeoutMs, onEvent, failureCaptureDir }) =>
      new Promise((resolve, reject) => {
        const work = mkdtempSync(join(tmpdir(), "qa-pw-"));
        const reporterPath = join(work, "qa-stream-reporter.cjs");
        const jsonPath = join(work, "report.json");
        writeFileSync(reporterPath, STREAM_REPORTER);

        const child = spawn("npx", playwrightArgs(reporterPath, project, specFiles), {
          cwd: dir,
          /* Agent-written specs are untrusted code: scrub orchestrator secrets, keep DEV_* creds. QA_FAILURE_CAPTURE_DIR: the qa-failure-capture afterEach fixture writes per-case aria snapshot dumps here on failure; the orchestrator harvests them post-run to populate QaCase.failureDom for the fix-loop grounding prompt. PW_TEST_ID_ATTRIBUTE: threads the configured testIdAttribute into the runner so playwright.config.ts resolves getByTestId correctly for the app's convention. PW_ACTION_TIMEOUT_MS: optional per-target override of the seed's action auto-wait bound (default 8000) so a slower DEV can widen it without editing the seed config — injected from the composition root (env-read confinement, this file's header). */
          env: authSessionEnv(authDir, { ...scrubEnv({ extraAllowed: /^DEV_/ }), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath, ...(testIdAttribute ? { PW_TEST_ID_ATTRIBUTE: testIdAttribute } : {}), ...(actionTimeoutMs ? { PW_ACTION_TIMEOUT_MS: actionTimeoutMs } : {}), ...(faultInject ? { QA_FAULT_INJECT: "1" } : {}), ...(failureCaptureDir ? { QA_FAILURE_CAPTURE_DIR: failureCaptureDir } : {}) }),
          detached: true,
        });

        const stderr = new BoundedOutputTail(E2E_STDERR_KEEP_CHARS);
        const events = new BoundedLineReader(MAX_STREAM_EVENT_LINE_CHARS, (line) => {
          const ev = parseStreamEvent(line);
          if (ev && onEvent) { try { onEvent(ev); } catch { /* advisory: never let the feed break the run */ } }
        });
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (onAbort) signal?.removeEventListener("abort", onAbort);
          fn();
        };

        const ms = timeoutMs ?? defaultTimeoutMs;
        const timer = setTimeout(() => {
          processKill.killTree(child);
          settle(() => resolve({ report: {}, logs: `playwright runner timed out after ${ms}ms — killed\n${stderr.text()}`, ran: false }));
        }, ms);

        const onAbort = signal
          ? () => {
              processKill.killTree(child);
              settle(() => resolve({ report: {}, logs: `playwright runner aborted by operator cancel — killed\n${stderr.text()}`, ran: false }));
            }
          : undefined;
        if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d: string) => events.feed(d));
        child.stderr.on("data", (d: string) => stderr.append(d));
        child.on("error", (err) => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } settle(() => reject(err)); });
        child.on("close", (code, signal) => {
          /* The child is gone, and the path it was handed is the one thing it could still have changed: the report is read strictly (see readPlaywrightReport), never waited on and never followed. A run that is settled already (it timed out or the operator cancelled, and the child was killed) is waited for by nobody, so its report is not read: parsing one made slow on purpose would only hold the orchestrator after the deadline. */
          const read = settled ? undefined : readReport(jsonPath);
          try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
          if (read === undefined) return;
          const refusal = !read.ran && "reason" in read ? `\n[qa] the Playwright report was not read (${read.reason}); this run has no result.` : "";
          settle(() => resolve({ report: read.ran ? read.report : {}, logs: stderr.text() + refusal, ran: read.ran, exitCode: code ?? undefined, ...(signal ? { signal } : {}) }));
        });
      }),
  };
}
