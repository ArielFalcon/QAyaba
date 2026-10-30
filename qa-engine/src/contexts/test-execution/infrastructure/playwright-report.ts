import type { CaseStatus, ExpectedStatus, QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { SkippedTest } from "../domain/skipped-test.ts";
import { redactAndBound } from "../../../shared-infrastructure/redaction/redact-and-bound.ts";
import { LOAD_ERROR_MESSAGE_SAFETY_BOUND, MAX_LOAD_ERRORS_KEPT, type SpecLoadError } from "../domain/spec-load-error.ts";

export interface PwCase {
  name: string;
  status: CaseStatus;
  /* The status the test declared (the report's `expectedStatus`); absent when the report states none. */
  expectedStatus?: ExpectedStatus;
  detail?: string;
  file?: string;
}

export interface ParsedReport {
  verdict: RunVerdict;
  passed: boolean;
  cases: PwCase[];
  /* The tests the report says were skipped: no case, but their file loaded. */
  skippedTests: SkippedTest[];
  executed: number;
  /* The report's top-level errors: what stopped a spec from loading. Their file is as Playwright wrote it (absolute); the caller makes it suite-relative. */
  loadErrors: SpecLoadError[];
}

interface PwResult {
  status?: string;
  error?: { message?: string };
}
interface PwTest {
  results?: PwResult[];
  status?: string;
  expectedStatus?: string;
  annotations?: { type?: string }[];
}
interface PwSpec {
  title?: string;
  ok?: boolean;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  errors?: unknown;
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
}

const OK_STATUSES = new Set(["passed", "expected"]);

type SpecOutcome = CaseStatus | "skipped";

/*
 * What became of each test of a spec, by what its author declared and not by how it ended. Playwright reports a test its author skipped
 * (`test.skip`, `test.fixme`, `testInfo.skip()`, a skipping condition) with `expectedStatus: "skipped"`, even when an attempt failed
 * first; a test that never ran because another failed (a serial step after a failing one, everything under a failing `beforeAll`) is
 * `status: "skipped"` too, but with `expectedStatus: "passed"` and no annotation. The report that states no expectedStatus is read as the
 * author's skip, the side that refuses.
 */
function split(spec: PwSpec): { ran: PwTest[]; declaredSkip: PwTest[] } {
  const ran: PwTest[] = [];
  const declaredSkip: PwTest[] = [];
  for (const t of spec.tests ?? []) {
    if (t.expectedStatus === "skipped") declaredSkip.push(t);
    else if (t.status === "skipped" && t.expectedStatus !== "passed" && t.expectedStatus !== "failed") declaredSkip.push(t);
    else if (t.status === "skipped") continue;
    else ran.push(t);
  }
  return { ran, declaredSkip };
}

export function parsePlaywrightReport(json: unknown): ParsedReport {
  const report = (json ?? {}) as PwReport;
  const cases: PwCase[] = [];
  const skippedTests: SkippedTest[] = [];

  const walk = (suites: PwSuite[] | undefined, prefix: string, file: string | undefined): void => {
    for (const suite of suites ?? []) {
      const title = [prefix, suite.title].filter(Boolean).join(" › ");
      for (const spec of suite.specs ?? []) {
        const name = [title, spec.title].filter(Boolean).join(" › ");
        const { ran, declaredSkip } = split(spec);
        const noTests = (spec.tests ?? []).length === 0;
        const skip = (tests: PwTest[]): void => {
          const annotation = skipAnnotation({ ...spec, tests });
          skippedTests.push({ name, ...(file ? { file } : {}), ...(annotation ? { annotation } : {}) });
        };
        if (declaredSkip.length > 0) skip(declaredSkip);
        /* A test that did not run because another failed (a serial step after a failing one, everything under a failing beforeAll) is neither a case nor a skip its author wrote: it proves nothing and is not refused. */
        if (ran.length === 0 && !noTests) continue;
        const ranSpec: PwSpec = noTests ? spec : { ...spec, tests: ran };
        const outcome = specOutcome(ranSpec);
        if (outcome === "skipped") {
          /* The spec-level fields alone, or results that all skipped, say it did not run. */
          if (declaredSkip.length === 0) skip(ran);
          continue;
        }
        const declared = declaredStatus(ranSpec);
        const c: PwCase & Pick<QaCase, "file"> = {
          name,
          status: outcome,
          ...(declared ? { expectedStatus: declared } : {}),
          detail:
            outcome === "pass"
              ? undefined
              : outcome === "flaky"
                ? `flaky — passed only after a retry; first-attempt failure: ${firstError(ranSpec) ?? "(no error captured in the report)"}`
                : firstError(ranSpec),
          ...(file ? { file } : {}),
        };
        cases.push(c);
      }
      walk(suite.suites, title, file);
    }
  };

  for (const topSuite of report.suites ?? []) {
    const fileTitle = topSuite.title || undefined;
    walk([topSuite], "", fileTitle);
  }

  const executed = countExecuted(report, cases);
  const verdict = aggregate(cases, report, executed);
  return { verdict, passed: verdict === "pass", cases, skippedTests, executed, loadErrors: readLoadErrors(report.errors) };
}

/* The report is the child's: every field is checked, and an entry that is not a message is left out. */
function readLoadErrors(raw: unknown): SpecLoadError[] {
  if (!Array.isArray(raw)) return [];
  const errors: SpecLoadError[] = [];
  for (const entry of raw) {
    if (errors.length >= MAX_LOAD_ERRORS_KEPT) break;
    const { message, location } = (entry ?? {}) as { message?: unknown; location?: unknown };
    if (typeof message !== "string" || message.trim() === "") continue;
    const where = (location ?? {}) as { file?: unknown; line?: unknown; column?: unknown };
    const error: SpecLoadError = { message: redactAndBound(message, LOAD_ERROR_MESSAGE_SAFETY_BOUND) };
    if (typeof where.file === "string" && where.file !== "") {
      error.location = {
        file: where.file,
        ...(typeof where.line === "number" && Number.isInteger(where.line) && where.line > 0 ? { line: where.line } : {}),
        ...(typeof where.column === "number" && Number.isInteger(where.column) && where.column > 0 ? { column: where.column } : {}),
      };
    }
    errors.push(error);
  }
  return errors;
}

/* Fail-closed: an unrecognized status is a fail, never a silent pass. */
function specOutcome(spec: PwSpec): SpecOutcome {
  const statuses = (spec.tests ?? []).map((t) => t.status).filter(Boolean) as string[];
  if (statuses.length) {
    if (statuses.includes("unexpected")) return "fail";
    if (statuses.includes("flaky")) return "flaky";
    if (statuses.includes("expected")) return "pass";
    if (statuses.every((s) => s === "skipped")) return "skipped";
    return "fail"; /* unknown status (timedOut/interrupted/…) → fail-closed */
  }
  const results = (spec.tests ?? []).flatMap((t) => t.results ?? []);
  const resultStatuses = results.map((r) => r.status ?? "").filter(Boolean);
  if (resultStatuses.length && resultStatuses.every((s) => s === "skipped")) return "skipped";
  if (spec.ok === undefined && resultStatuses.length === 0) return "skipped";
  const ok = spec.ok ?? results.every((r) => OK_STATUSES.has(r.status ?? ""));
  return ok ? "pass" : "fail";
}

/* The status a test declared before it ran: failed when any of its tests is marked to fail, passed when the report says so, none when it states nothing. */
function declaredStatus(spec: PwSpec): ExpectedStatus | undefined {
  const declared = (spec.tests ?? []).map((t) => t.expectedStatus);
  if (declared.includes("failed")) return "failed";
  return declared.includes("passed") ? "passed" : undefined;
}

/* The annotation that skipped a test, as the report names its type; a test skipped by a condition alone carries none. */
function skipAnnotation(spec: PwSpec): string | undefined {
  for (const t of spec.tests ?? []) {
    for (const a of t.annotations ?? []) {
      if (typeof a.type === "string" && (a.type === "skip" || a.type === "fixme")) return a.type;
    }
  }
  return undefined;
}

function countExecuted(report: PwReport, cases: PwCase[]): number {
  const s = report.stats;
  if (s && (s.expected != null || s.unexpected != null || s.flaky != null || s.skipped != null)) {
    return (s.expected ?? 0) + (s.unexpected ?? 0) + (s.flaky ?? 0);
  }
  return cases.length;
}

function aggregate(cases: PwCase[], report: PwReport, executed: number): RunVerdict {
  if (cases.some((c) => c.status === "fail")) return "fail";
  if (cases.some((c) => c.status === "flaky")) return "flaky";
  if ((report.stats?.unexpected ?? 0) > 0) return "fail";
  if ((report.stats?.flaky ?? 0) > 0) return "flaky";
  if (executed === 0) return "infra-error";
  return "pass";
}

function firstError(spec: PwSpec): string | undefined {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      if (r.error?.message) return r.error.message;
    }
  }
  return undefined;
}
