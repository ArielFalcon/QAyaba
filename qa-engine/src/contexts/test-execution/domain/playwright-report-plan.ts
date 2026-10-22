/*
 * What a Playwright JSON report says about time: which spec files ran, which cases each held and how each attempt went, with the
 * report's own start times and durations. The report is written by the test process, so it is untrusted: every field is read defensively,
 * the number of files, cases and attempts is bounded, a time is clamped and a field of the wrong type is ignored. Pure.
 */

import { classifyFailure, locatorStrategy, strictModeMatchCount, type FailureCategory, type SelectorStrategy } from "./failure-category.ts";
import { stripAnsi } from "@kernel/ansi.ts";

export const MAX_PLANNED_FILES = 200;
export const MAX_PLANNED_CASES = 1000;
export const MAX_PLANNED_ATTEMPTS = 10;
const MAX_MESSAGE_CHARS = 2000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/* A time in a report may precede the phase by this much (clock skew between the child and the host) and no more. */
export const START_SLACK_MS = 60_000;
/* How far back a time may reach when the phase's own start is not known. */
const FALLBACK_WINDOW_MS = 3 * 60 * 60 * 1000;

export type AttemptStatus = "passed" | "failed" | "timedOut" | "interrupted" | "skipped";
export type CaseStatus = "passed" | "failed" | "flaky" | "skipped" | "timedOut" | "interrupted";

export interface PlannedAttempt {
  index: number;
  status: AttemptStatus;
  startMs: number;
  endMs: number;
  errorMessage?: string;
  failureCategory?: FailureCategory;
  strictMatchCount?: number;
  strategy?: SelectorStrategy;
}

export interface PlannedCase {
  name: string;
  /* The case's report name as `parsePlaywrightReport` spells it: the top suite's title (its file, then "(unknown)") first, then the nested suite titles, then the spec title. `name` is the same chain without the file. */
  fullName: string;
  status: CaseStatus;
  retries: number;
  startMs: number;
  endMs: number;
  attempts: PlannedAttempt[];
  /* Category and locator kind of the case's first failing attempt. */
  failureCategory?: FailureCategory;
  strategy?: SelectorStrategy;
}

export interface PlannedFile {
  file: string;
  startMs: number;
  endMs: number;
  cases: PlannedCase[];
}

export interface ReportPlan {
  files: PlannedFile[];
  /* Cases or files the bounds left out. */
  omitted: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function attemptStatus(v: unknown): AttemptStatus {
  return v === "passed" || v === "failed" || v === "timedOut" || v === "interrupted" || v === "skipped" ? v : "failed";
}

function errorOf(result: Record<string, unknown>): string | undefined {
  const single = isRecord(result.error) ? str(result.error.message) : undefined;
  if (single) return single;
  for (const e of list(result.errors)) if (isRecord(e) && str(e.message)) return str(e.message);
  return undefined;
}

function caseStatusOf(test: Record<string, unknown>, attempts: PlannedAttempt[]): CaseStatus {
  const last = attempts[attempts.length - 1];
  switch (test.status) {
    case "expected":
      return "passed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    case "unexpected":
      return last?.status === "timedOut" || last?.status === "interrupted" ? last.status : "failed";
    default:
      return last ? (last.status === "passed" ? "passed" : last.status === "skipped" ? "skipped" : "failed") : "skipped";
  }
}

function planAttempts(test: Record<string, unknown>, fallbackStart: number, deniedHosts: readonly string[], clamp: (ms: number, floor: number) => number, lo: number): PlannedAttempt[] {
  const attempts: PlannedAttempt[] = [];
  let cursor = fallbackStart;
  for (const raw of list(test.results).slice(0, MAX_PLANNED_ATTEMPTS)) {
    if (!isRecord(raw)) continue;
    const parsed = typeof raw.startTime === "string" ? Date.parse(raw.startTime) : NaN;
    /* The report is written by the test process: no time in it reaches before the phase or past now. */
    const startMs = clamp(Number.isFinite(parsed) ? parsed : cursor, lo);
    const duration = typeof raw.duration === "number" && Number.isFinite(raw.duration) ? Math.min(Math.max(0, raw.duration), MAX_DURATION_MS) : 0;
    const status = attemptStatus(raw.status);
    /* ANSI is stripped before the cut so a slice can never leave half an escape sequence; classifyFailure strips again internally. */
    const rawMessage = status === "passed" || status === "skipped" ? undefined : errorOf(raw);
    const message = rawMessage === undefined ? undefined : stripAnsi(rawMessage).slice(0, MAX_MESSAGE_CHARS);
    const category = message === undefined ? undefined : classifyFailure(message, { deniedHosts });
    const strict = message === undefined ? undefined : strictModeMatchCount(message);
    const strategy = message === undefined ? undefined : locatorStrategy(message);
    attempts.push({
      index: typeof raw.retry === "number" && Number.isSafeInteger(raw.retry) && raw.retry >= 0 ? raw.retry : attempts.length,
      status,
      startMs,
      endMs: clamp(startMs + duration, startMs),
      ...(message !== undefined ? { errorMessage: message } : {}),
      ...(category !== undefined ? { failureCategory: category } : {}),
      ...(strict !== undefined ? { strictMatchCount: strict } : {}),
      ...(strategy !== undefined ? { strategy } : {}),
    });
    cursor = clamp(startMs + duration, startMs);
  }
  return attempts;
}

/* Walks the report's suites: a top-level suite is a file, and its nested suites add to the title chain of its cases. */
export function planReport(report: unknown, opts: { deniedHosts?: readonly string[]; nowMs: number; phaseStartMs?: number }): ReportPlan {
  const lo = (opts.phaseStartMs ?? opts.nowMs - FALLBACK_WINDOW_MS) - START_SLACK_MS;
  const hi = opts.nowMs;
  const clamp = (ms: number, floor: number): number => Math.min(hi, Math.max(floor, ms));
  const files: PlannedFile[] = [];
  let cases = 0;
  let omitted = 0;
  const deniedHosts = opts.deniedHosts ?? [];
  const visit = (suite: Record<string, unknown>, titles: string[], file: PlannedFile, firstSegment: string): void => {
    for (const rawSpec of list(suite.specs)) {
      if (!isRecord(rawSpec)) continue;
      for (const rawTest of list(rawSpec.tests)) {
        if (!isRecord(rawTest)) continue;
        if (cases >= MAX_PLANNED_CASES) {
          omitted += 1;
          continue;
        }
        const attempts = planAttempts(rawTest, file.endMs || opts.nowMs, deniedHosts, clamp, lo);
        const status = caseStatusOf(rawTest, attempts);
        const failing = attempts.find((a) => a.status === "failed" || a.status === "timedOut" || a.status === "interrupted");
        const startMs = attempts[0]?.startMs ?? opts.nowMs;
        const endMs = attempts[attempts.length - 1]?.endMs ?? startMs;
        cases += 1;
        file.cases.push({
          name: [...titles, str(rawSpec.title)].filter(Boolean).join(" › "),
          fullName: [firstSegment, ...titles, str(rawSpec.title)].filter(Boolean).join(" › "),
          status,
          retries: Math.max(0, attempts.length - 1),
          startMs,
          endMs,
          attempts,
          ...(failing?.failureCategory !== undefined ? { failureCategory: failing.failureCategory } : {}),
          ...(failing?.strategy !== undefined ? { strategy: failing.strategy } : {}),
        });
        file.startMs = file.startMs === 0 ? startMs : Math.min(file.startMs, startMs);
        file.endMs = Math.max(file.endMs, endMs);
      }
    }
    for (const child of list(suite.suites)) {
      if (isRecord(child)) visit(child, [...titles, str(child.title)].filter((t): t is string => t !== undefined), file, firstSegment);
    }
  };
  for (const top of list(isRecord(report) ? report.suites : undefined)) {
    if (!isRecord(top)) continue;
    if (files.length >= MAX_PLANNED_FILES) {
      omitted += 1;
      continue;
    }
    const planned: PlannedFile = { file: str(top.file) ?? str(top.title) ?? "(unknown)", startMs: 0, endMs: 0, cases: [] };
    /* The top suite's title is the first segment of a case's report name (nested suites follow it), spelled exactly as parsePlaywrightReport spells it: no fallback when the report has none. */
    visit(top, [], planned, str(top.title) ?? "");
    if (planned.cases.length > 0) files.push(planned);
  }
  return { files, omitted };
}
