/* E2E Playwright runner against live DEV. Timeouts and recordAudit are injected — this module never reads process.env and never imports src/orchestrator. */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { QaCase, CaseStatus } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { redactByValue } from "../../../shared-infrastructure/run-secret-redaction.ts";
import { sanitizeText, type SecretDetection } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { parseAriaSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { BoundedLineReader } from "@kernel/process-sandbox/bounded-line-reader.ts";
import { BoundedOutputTail } from "@kernel/process-sandbox/bounded-output-tail.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import type { ExecSandboxPort } from "../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { describeReasons, readRunOutputDir, scanRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";
import { readFailureReason, readOwnedSpecFile, type OwnedSpecRead } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { parsePlaywrightReport } from "./playwright-report.ts";
import { PLAYWRIGHT_INFRA_RE } from "../domain/playwright-infra.ts";
import { openDumpBridge } from "./run-dump-bridge.ts";

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

/* One plain relative spec file: directory segments of letters, digits, dots, dashes and underscores (never `.` or `..`, never empty), and a file name that starts with a letter, digit, dash or underscore, so `..spec.ts` and `.spec.ts` are not names. A segment may begin with a dot (the probe directory `.qa-probe`). */
export const SPEC_FILE_RE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.spec\.ts$/;

function assertSpecFiles(specFiles: string[]): void {
  for (const f of specFiles) {
    if (f.startsWith("-")) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: must not start with "-"`);
    }
    if (f.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: path traversal not allowed`);
    }
    if (!SPEC_FILE_RE.test(f)) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: must match ${String(SPEC_FILE_RE)}`);
    }
  }
}

/* The content of the test list that selects exactly these spec files: one path per line, relative to the suite. Playwright reads a bare argument as an unanchored, case-insensitive regular expression over the file's whole path (`a.spec.ts` also selects `schema.spec.ts`), so a spec is never named that way; `--test-list` compares each line to a file's path whole. Throws on a path that is not one plain relative spec file, so no line can carry a second path, a project prefix or a title. */
export function specListContent(specFiles: string[]): string {
  assertSpecFiles(specFiles);
  return specFiles.map((f) => `${f}\n`).join("");
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
  /* Attempts after the first failure; 0 makes a run a single attempt (the suite's own config retries otherwise). */
  retries?: number;
  /* A literal title filter, escaped for Playwright's --grep by the caller. */
  grep?: string;
  /* Have the fixtures count the mutating requests the specs send to DEV (PW_COUNT_DEV_WRITES) and report the total in `devWrites`. Such a run is a spec the generator is trying, not the suite: it is not measured for change-coverage (PW_COVERAGE=0), which would only slow it. */
  countWrites?: boolean;
  /* Run as the dedicated cleanup pass: the child is handed PW_CLEANUP=1, which the seed's cleanup.spec.ts needs to do anything (it skips otherwise), and `namespace` is then the BASE data prefix to clean. */
  cleanupPass?: boolean;
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
  /* The app's browser position, handed to every suite child. Absent: the suite's own default. */
  geolocation?: { latitude: number; longitude: number };
  runSuite(args: {
    dir: string;
    baseUrl: string;
    namespace: string;
    geolocation?: { latitude: number; longitude: number };
    testIdAttribute?: string;
    faultInject?: boolean;
    project?: string;
    specFiles?: string[];
    retries?: number;
    grep?: string;
    countWrites?: boolean;
    cleanupPass?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    onEvent?: (ev: StreamEvent) => void;
    failureCaptureDir?: string;
  }): Promise<E2eRunOutput>;
  defaultTimeoutMs?: number;
  /* A directory for the failure dumps of one run, inside the run's work dir, and the root the strict reader walks from. Absent (a fake runner): runE2E makes a temp dir of its own. */
  allocateFailureDir?(): { dir: string; root: string; dispose(): void };
  /* OPTIONAL diagnostic sink for a secret-redaction audit trail (src/orchestrator/sanitizer.ts's recordAudit/SECRET_AUDIT — a security-boundary concern this module does not import directly, to stay src/-free). Absent ⇒ no audit recorded (safe for every unit test that doesn't care about it). The composition-root shell (rewritten-engine-factory.ts) binds the REAL recordAudit into createDefaultE2eExecuteDeps's returned object, so production behavior is unchanged. */
  recordAudit?(runId: string, detection: SecretDetection): void;
  /* OPTIONAL read-only observer of a report-shaped Playwright JSON report, told once per run before the verdict is derived (the shell turns it into spans). It never alters the report or the verdict; a fault in it is logged and ignored. */
  onReport?(report: unknown): void;
}

/** Local result shape so this file stays src/-free. */
export interface E2eRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean;
  cases: QaCase[];
  logs: string;
  note?: string;
  /* Mutating requests the specs sent to DEV, as the fixtures counted them; absent when nothing trustworthy was counted. */
  devWrites?: number;
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
  let failureCaptureRoot: string | undefined;
  let disposeFailureDir: (() => void) | undefined;
  if (deps.allocateFailureDir) {
    const alloc = deps.allocateFailureDir();
    failureCaptureDir = alloc.dir;
    failureCaptureRoot = alloc.root;
    disposeFailureDir = alloc.dispose;
  } else {
    try { failureCaptureDir = mkdtempSync(join(tmpdir(), "qa-fail-")); } catch { /* no-op */ }
  }

  try {
  const runPromise = deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
    ...(deps.geolocation ? { geolocation: deps.geolocation } : {}),
    faultInject: opts.faultInject,
    /* No project unless one is configured: the repo owns its playwright.config.ts, so every project it defines runs. The seed keeps its login setup project out of a suite run itself (it is defined only under PW_AUTH_SETUP). */
    project: opts.project,
    testIdAttribute: opts.testIdAttribute,
    specFiles: opts.specFiles,
    retries: opts.retries,
    grep: opts.grep,
    countWrites: opts.countWrites,
    cleanupPass: opts.cleanupPass,
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
  /* The ledger is read before any early return, but only believed for a run that finished and whose report says how many tests ran: a stopped run has no ledger for the test it was running, and a ledger short of the tests that ran has lost some, so the writes of either are unknown and the caller charges the whole cap (see readDevWrites). */
  const ledger = opts.countWrites ? readDevWrites(failureCaptureDir, failureCaptureRoot) : undefined;
  const counted = (result: E2eRunResult, executed?: number): E2eRunResult =>
    ledger === undefined || executed === undefined || ledger.files < executed ? result : { ...result, devWrites: ledger.writes };

  /* Single sanitizeText pass: a separate containsSecrets() pre-check is redundant with this SAME detection result (mirrors code-execution.runner.ts's own AMENDMENT-1 simplification) — the warn fires under the exact same condition as before, just derived from one call instead of two. */
  const sanitized = sanitizeText(logs);
  if (sanitized.detection.redacted) {
    console.warn("[sanitizer] Secrets detected in E2E execution logs — redacting before publish");
  }
  deps.recordAudit?.(opts.namespace, sanitized.detection);

  /* The temp capture dir is removed on EVERY exit path — the early infra-error returns below, the main return, a throw from the harvest, AND a runSuite REJECT — via the finally at the end. A runner that produced no parseable report did not actually run the suite — it crashed (bad config, browser launch failure, OOM). That is INFRASTRUCTURE, not a pass: never let a swallowed parse error surface as green (the #1 invariant). */
  if (!ran || !isReportShaped(report)) {
    return counted({
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: sanitized.text || "the E2E runner produced no report (it crashed before reporting results)",
    });
  }

  try {
    deps.onReport?.(report);
  } catch (err) {
    console.error(`[qa] the report observer failed (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parsePlaywrightReport(report);

  if (parsed.executed === 0) {
    return counted({
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: parsed.cases,
      logs: sanitized.text || "the E2E suite ran but executed zero tests (no tests matched, or all were skipped)",
    }, parsed.executed);
  }

  /* The report is written by the test process, so a report that says every test passed cannot be told from a forged one by what it holds. How the child ended can: Playwright exits with a failure status when a test failed, and a child that a signal ended never finished reporting. A pass that the child did not exit 0 for is a run that cannot be trusted: infrastructure, and none of its cases is handed on. A failure stays a failure whatever the status; the status only takes a pass away. */
  const distrust = parsed.verdict === "pass" ? untrustedExit(out) : undefined;
  if (distrust !== undefined) {
    return counted({
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: `${sanitized.text}\n[qa] ${distrust}`.trim(),
      note: distrust,
    }, parsed.executed);
  }

  if (parsed.verdict === "fail" && allFailuresAreRunnerInfra(parsed.cases)) {
    return counted({
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: parsed.cases,
      logs: sanitized.text,
      note: "Playwright could not launch the browser — runner infrastructure fault, not a test failure. Check the browser install / PLAYWRIGHT_BROWSERS_PATH.",
    }, parsed.executed);
  }

  /* Post-run harvest: for each failed case, read the aria snapshot dump written by the qa-failure-capture afterEach fixture and populate QaCase.failureDom. The pipeline splits this back into lines without re-parsing. The fixture dump is the ONLY source — Playwright's JSON reporter carries no per-error DOM snapshot to fall back to (JSONReportError is just {message, location?}). LOUD WARNING when a failed case yields no dump — this is a grounding gap (invariant: never swallow, per CLAUDE.md). Post-run harvest over PwCase[] (before widening to QaCase[]): we mutate the same objects (same references) — the cast to QaCase[] below picks up the failureDom we set here because the runtime objects are identical. */
  const failedPwCases = parsed.cases.filter((c) => c.status === "fail");
  if (failedPwCases.length > 0) {
    /* The per-case harvest runs whenever there are failed cases — NOT gated on failureCaptureDir. When the dir is absent (e.g. mkdtempSync failed for lack of /tmp space) `dumps` is simply [] and every failed case falls straight to the loud "no grounding captured" WARNING below. Gating the whole loop on the dir silently dropped the WARNING — violating the never-swallow invariant. Read every dump ONCE into {file, title, retry, yaml}: matching keys off the dump's own `file` + `title` (the describe›test chain the fixture wrote), which the report's case name ENDS WITH — the report prepends the spec file as the top suite, the fixture records it as a separate `file`. */
    const dumps = failureCaptureDir ? readFailureDumps(failureCaptureDir, FAILURE_DUMP_LIMITS, failureCaptureRoot) : [];
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
  /* A spec can print the account's password into an assertion message, and a page can echo it into the DOM the fixture dumped: what a child reported has the run's secrets taken out by value where it enters, before anything stores or forwards a case. */
  for (const c of qaCases) redactCaseByValue(c);

  return counted({
    sha: opts.namespace,
    verdict: parsed.verdict,
    passed: parsed.passed,
    cases: qaCases,
    logs: sanitized.text,
  }, parsed.executed);
  } finally {
    if (disposeFailureDir) disposeFailureDir();
    else if (failureCaptureDir) {
      try { rmSync(failureCaptureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

/* The writes to DEV the specs of a run sent, from the ledger files the fixtures left in the failure-capture directory, and how many files that was (one per test that ran). The directory is the child's, so it is read strictly (see readRunOutputDir) and all or nothing: a missing, forged, oversized or unreadable file makes the whole count unknown (undefined) and never a smaller one. The counter itself runs inside the suite's own fixtures, which is agent-editable code, so a ledger is evidence of what the spec did only against an honest spec; the hard bound on what a call can do to DEV is the call cap times the per-call time, and the egress filter. */
const LEDGER_FILE_RE = /^ledger-[A-Za-z0-9_-]+\.json$/;
const LEDGER_LIMITS: RunOutputLimits = { maxFileBytes: 4_096, maxTotalBytes: 1024 * 1024, maxFiles: 4_096 };
const MAX_LEDGER_WRITES = 1_000_000;

function readDevWrites(dir: string | undefined, root: string | undefined): { writes: number; files: number } | undefined {
  if (dir === undefined) return undefined;
  const base = root ?? dir;
  const files = readRunOutputDir({ mirrorDir: base, specDir: base }, relative(base, dir) || ".", (name) => LEDGER_FILE_RE.test(name), (_name, bytes) => {
    const writes = (JSON.parse(bytes.toString("utf8")) as { writes?: unknown }).writes;
    if (typeof writes !== "number" || !Number.isInteger(writes) || writes < 0 || writes > MAX_LEDGER_WRITES) throw new Error("not a count");
    return writes;
  }, LEDGER_LIMITS);
  return files === undefined || files.length === 0 ? undefined : { writes: files.reduce((sum, n) => sum + n, 0), files: files.length };
}

function redactCaseByValue(c: QaCase): void {
  c.name = redactByValue(c.name);
  if (c.detail !== undefined) c.detail = redactByValue(c.detail);
  if (c.failureDom !== undefined) c.failureDom = redactByValue(c.failureDom);
  if (c.finalUrl !== undefined) c.finalUrl = redactByValue(c.finalUrl);
  if (c.runtimeErrors !== undefined) c.runtimeErrors = c.runtimeErrors.map((e) => ({ type: e.type, text: redactByValue(e.text) }));
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
export function readPlaywrightReport(jsonPath: string, maxBytes: number = MAX_PLAYWRIGHT_REPORT_BYTES, root: string = dirname(jsonPath)): PlaywrightReportRead {
  let read: OwnedSpecRead;
  try {
    read = readOwnedSpecFile({ mirrorDir: root, specDir: root }, relative(root, jsonPath), maxBytes);
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
export function readFailureDumps(dir: string, limits: RunOutputLimits = FAILURE_DUMP_LIMITS, root: string = dir): FailureDump[] {
  const scan = scanRunOutputDir({ mirrorDir: root, specDir: root }, relative(root, dir) || ".", (name) => DUMP_FILE_RE.test(name), toFailureDump, limits, { readCut: true });
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

/* Both runners start their child through the execution launcher (`exec`), which owns the sandbox uid, the environment of the `suite` profile, the saved session (a fresh copy in the run's work dir, never the orchestrator's auth directory) and the egress lease. There is no default launcher: a runner that could start Playwright without one would run agent-written specs as the orchestrator. */
export function createDefaultE2eCleanupDeps(processKill: ProcessKillPort = new ProcessKillAdapter(), exec: ExecSandboxPort): E2eCleanupDeps {
  if (!exec) {
    throw new Error("[qa] createDefaultE2eCleanupDeps requires an execution launcher — there is no safe default (a cleanup spec is agent-written code).");
  }
  return {
    runCleanup: ({ dir, baseUrl, namespace, testIdAttribute, signal, timeoutMs }) =>
      new Promise((resolve) => {
        const callDir = exec.allocDir("cleanup", ["results"]);
        const child = exec.spawn("npx", cleanupArgs(join(callDir, "results")), {
          cwd: dir,
          profile: "suite",
          commandClass: "playwright-test",
          extraEnv: { PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PW_CLEANUP: "1", ...(testIdAttribute ? { PW_TEST_ID_ATTRIBUTE: testIdAttribute } : {}) },
          /* Nothing reads the cleanup's output. Piped and unread, it would block the child once the OS pipe buffer fills, and keep the pipes open to any descendant that outlives it. */
          stdio: "ignore",
        });
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (onAbort) signal?.removeEventListener("abort", onAbort);
          try { rmSync(callDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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

export function cleanupArgs(outputDir: string): string[] {
  return ["playwright", "test", "cleanup.spec.ts", "--reporter=line", `--output=${outputDir}`];
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

/* The most attempts after a failure a caller may ask for, and the longest title filter. */
const MAX_RETRIES = 10;
const MAX_GREP_CHARS = 200;

export function playwrightArgs(reporterPath: string, project?: string, testListPath?: string, outputDir?: string, narrow: { retries?: number | undefined; grep?: string | undefined } = {}): string[] {
  const args = ["playwright", "test", `--reporter=${reporterPath},json`];
  /* Where Playwright writes traces, screenshots and videos: the run's work dir, because the mirror is read-only to the sandbox uid. */
  if (outputDir !== undefined) args.push(`--output=${outputDir}`);
  if (project !== undefined) {
    if (!PW_PROJECT_RE.test(project)) {
      throw new Error(`invalid Playwright project name ${JSON.stringify(project)}: must match ${String(PW_PROJECT_RE)}`);
    }
    args.push(`--project=${project}`);
  }
  if (narrow.retries !== undefined) {
    if (!Number.isInteger(narrow.retries) || narrow.retries < 0 || narrow.retries > MAX_RETRIES) throw new Error(`invalid retries ${JSON.stringify(narrow.retries)}: must be an integer from 0 to ${MAX_RETRIES}`);
    args.push(`--retries=${narrow.retries}`);
  }
  if (narrow.grep !== undefined) {
    if (typeof narrow.grep !== "string" || narrow.grep === "" || narrow.grep.length > MAX_GREP_CHARS) throw new Error(`invalid grep: must be a non-empty string of at most ${MAX_GREP_CHARS} characters`);
    args.push(`--grep=${narrow.grep}`);
  }
  if (testListPath !== undefined) {
    if (testListPath === "" || testListPath.startsWith("-")) throw new Error(`invalid test list path ${JSON.stringify(testListPath)}`);
    args.push(`--test-list=${testListPath}`);
  }
  return args;
}

/* `exec` is the execution launcher, required for the reason createDefaultE2eCleanupDeps gives. The Playwright report, the stream reporter and the failure dumps live in a fresh directory of the run's work dir, the one place the sandbox uid writes, and are read back strictly (a link or a pipe planted there is refused). */
export function createDefaultE2eExecuteDeps(
  processKill: ProcessKillPort = new ProcessKillAdapter(),
  defaultTimeoutMs: number = DEFAULT_E2E_TIMEOUT_MS,
  exec: ExecSandboxPort,
  actionTimeoutMs?: string,
  /* The read of the report the child left, a seam so that a test can see when it is made. `root` is the directory the strict reader walks from. */
  readReport: (jsonPath: string, root: string) => PlaywrightReportRead = (jsonPath, root) => readPlaywrightReport(jsonPath, MAX_PLAYWRIGHT_REPORT_BYTES, root),
): E2eExecuteDeps {
  if (!exec) {
    throw new Error("[qa] createDefaultE2eExecuteDeps requires an execution launcher — there is no safe default (the specs are agent-written code).");
  }
  return {
    defaultTimeoutMs,
    allocateFailureDir: () => {
      const dir = exec.allocDir("failures", ["dumps"]);
      return { dir: join(dir, "dumps"), root: exec.workDir(), dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } };
    },
    runSuite: ({ dir, baseUrl, namespace, geolocation, testIdAttribute, faultInject, project, specFiles, retries, grep, countWrites, cleanupPass, signal, timeoutMs, onEvent, failureCaptureDir }) =>
      new Promise((resolve, reject) => {
        /* The specs to run, as a file the orchestrator writes (root-owned, read-only to the sandbox): the child is told which files by an exact list, never by a pattern. */
        const testListPath = specFiles !== undefined && specFiles.length > 0 ? exec.writeScript("spec-list.txt", specListContent(specFiles)) : undefined;
        const work = exec.allocDir("pw", ["report", "results"]);
        const workRoot = exec.workDir();
        const reporterPath = join(work, "qa-stream-reporter.cjs");
        const jsonPath = join(work, "report", "report.json");
        writeFileSync(reporterPath, STREAM_REPORTER);
        /* The fixtures write the coverage and fault-injection dumps below the suite's own .qa, from the sandboxed child. Nothing the child writes lands in the mirror: those two paths lead to a folder of the run's work dir while it runs, and only the dumps that pass the check are carried over once it is gone (run-dump-bridge.ts). */
        const dumpRoot = exec.allocDir("dumps", ["coverage", "fault-injection"]);
        const dumps = openDumpBridge({ specDir: dir, namespace, dumpRoot, workRoot });
        let dumpsClosed = false;
        const closeDumps = (harvest: boolean): void => {
          if (dumpsClosed) return;
          dumpsClosed = true;
          try {
            if (harvest) dumps.harvest();
            else dumps.dispose();
          } catch (err) {
            console.error(`[qa] the dump folders of the run could not be handed over (${err instanceof Error ? err.message : String(err)}); the coverage and fault-injection signals stay unmeasured (non-blocking)`);
          } finally {
            try { rmSync(dumpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        };

        /* QA_FAILURE_CAPTURE_DIR: the qa-failure-capture afterEach fixture writes per-case aria snapshot dumps here on failure; the orchestrator harvests them post-run to populate QaCase.failureDom for the fix-loop grounding prompt. PW_TEST_ID_ATTRIBUTE: threads the configured testIdAttribute into the runner so playwright.config.ts resolves getByTestId correctly for the app's convention. PW_ACTION_TIMEOUT_MS: optional per-target override of the seed's action auto-wait bound (default 8000) so a slower DEV can widen it without editing the seed config — injected from the composition root (env-read confinement, this file's header). */
        const child = exec.spawn("npx", playwrightArgs(reporterPath, project, testListPath, join(work, "results"), { retries, grep }), {
          cwd: dir,
          profile: "suite",
          commandClass: "playwright-test",
          ...(geolocation ? { geolocation } : {}),
          extraEnv: { PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath, ...(cleanupPass ? { PW_CLEANUP: "1" } : {}), ...(countWrites ? { PW_COUNT_DEV_WRITES: "1", PW_COVERAGE: "0" } : {}), ...(testIdAttribute ? { PW_TEST_ID_ATTRIBUTE: testIdAttribute } : {}), ...(actionTimeoutMs ? { PW_ACTION_TIMEOUT_MS: actionTimeoutMs } : {}), ...(faultInject ? { QA_FAULT_INJECT: "1" } : {}), ...(failureCaptureDir ? { QA_FAILURE_CAPTURE_DIR: failureCaptureDir } : {}) },
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
          closeDumps(false);
          settle(() => resolve({ report: {}, logs: `playwright runner timed out after ${ms}ms — killed\n${stderr.text()}`, ran: false }));
        }, ms);

        const onAbort = signal
          ? () => {
              processKill.killTree(child);
              closeDumps(false);
              settle(() => resolve({ report: {}, logs: `playwright runner aborted by operator cancel — killed\n${stderr.text()}`, ran: false }));
            }
          : undefined;
        if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });

        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (d: string) => events.feed(d));
        child.stderr!.on("data", (d: string) => stderr.append(d));
        child.on("error", (err) => { closeDumps(false); try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } settle(() => reject(err)); });
        child.on("close", (code, signal) => {
          /* The child is gone, and the path it was handed is the one thing it could still have changed: the report is read strictly (see readPlaywrightReport), never waited on and never followed. A run that is settled already (it timed out or the operator cancelled, and the child was killed) is waited for by nobody, so its report is not read: parsing one made slow on purpose would only hold the orchestrator after the deadline. */
          const read = settled ? undefined : readReport(jsonPath, workRoot);
          closeDumps(!settled);
          try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
          if (read === undefined) return;
          const refusal = !read.ran && "reason" in read ? `\n[qa] the Playwright report was not read (${read.reason}); this run has no result.` : "";
          settle(() => resolve({ report: read.ran ? read.report : {}, logs: stderr.text() + refusal, ran: read.ran, exitCode: code ?? undefined, ...(signal ? { signal } : {}) }));
        });
      }),
  };
}
