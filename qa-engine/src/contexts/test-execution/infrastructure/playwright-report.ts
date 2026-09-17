import type { CaseStatus, QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";

export interface PwCase {
  name: string;
  status: CaseStatus;
  detail?: string;
  /* Playwright 1.60 attaches the aria snapshot of the receiver on expect() failures. Absent on older reports. */
  errorContext?: string;
  file?: string;
}

export interface ParsedReport {
  verdict: RunVerdict;
  passed: boolean;
  cases: PwCase[];
  executed: number;
}

interface PwResult {
  status?: string;
  error?: { message?: string };
  errors?: Array<{ message?: string; errorContext?: string }>;
}
interface PwTest {
  results?: PwResult[];
  status?: string;
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
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
}

const OK_STATUSES = new Set(["passed", "expected"]);

type SpecOutcome = CaseStatus | "skipped";

export function parsePlaywrightReport(json: unknown): ParsedReport {
  const report = (json ?? {}) as PwReport;
  const cases: PwCase[] = [];

  const walk = (suites: PwSuite[] | undefined, prefix: string, file: string | undefined): void => {
    for (const suite of suites ?? []) {
      const title = [prefix, suite.title].filter(Boolean).join(" › ");
      for (const spec of suite.specs ?? []) {
        const outcome = specOutcome(spec);
        if (outcome === "skipped") continue;
        const ec = firstErrorContext(spec);
        const c: PwCase & Pick<QaCase, "file"> = {
          name: [title, spec.title].filter(Boolean).join(" › "),
          status: outcome,
          detail:
            outcome === "pass"
              ? undefined
              : outcome === "flaky"
                ? `flaky — passed only after a retry; first-attempt failure: ${firstError(spec) ?? "(no error captured in the report)"}`
                : firstError(spec),
          ...(ec !== undefined ? { errorContext: ec } : {}),
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
  return { verdict, passed: verdict === "pass", cases, executed };
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

export function firstErrorContext(spec: PwSpec): string | undefined {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      const ctx = r?.errors?.[0]?.errorContext;
      if (typeof ctx === "string" && ctx.length > 0) return ctx;
    }
  }
  return undefined;
}
