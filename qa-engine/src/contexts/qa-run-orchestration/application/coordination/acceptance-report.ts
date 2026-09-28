/*
 * The sidekick's typed per-criterion acceptance report. The brief numbers its acceptance criteria
 * from 1 and the sidekick reports every one of them by that number. Reading is strict: an absent or
 * malformed report is a contract defect, never read as "met" — a criterion without a well-formed
 * entry stays unverified.
 */
import { scrub } from "./scrub.ts";

export const ACCEPTANCE_STATUSES = ["met", "unmet", "unverified"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export interface AcceptanceReportEntry {
  /** 1-based number of the criterion as the brief lists it. */
  readonly criterion: number;
  readonly status: AcceptanceStatus;
  readonly note?: string;
}

export const ACCEPTANCE_REPORT_DEFECTS = ["acceptance-report-missing", "acceptance-report-invalid"] as const;
export type AcceptanceReportDefectReason = (typeof ACCEPTANCE_REPORT_DEFECTS)[number];

export interface AcceptanceReportDefect {
  readonly reason: AcceptanceReportDefectReason;
  readonly detail: string;
}

export interface AcceptanceReport {
  readonly entries: readonly AcceptanceReportEntry[];
  readonly defect?: AcceptanceReportDefect;
}

function toEntry(item: unknown, criteriaCount: number): AcceptanceReportEntry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const { criterion, status, note } = item as Record<string, unknown>;
  if (typeof criterion !== "number" || !Number.isInteger(criterion) || criterion < 1 || criterion > criteriaCount) {
    return undefined;
  }
  if (typeof status !== "string" || !(ACCEPTANCE_STATUSES as readonly string[]).includes(status)) return undefined;
  return {
    criterion,
    status: status as AcceptanceStatus,
    ...(typeof note === "string" ? { note: scrub(note) } : {}),
  };
}

/* Reads the raw `acceptance` value of a sidekick answer against a brief with `criteriaCount` criteria. */
export function readAcceptanceReport(raw: unknown, criteriaCount: number): AcceptanceReport {
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [];
  if (items.length === 0) {
    if (criteriaCount === 0) return { entries: [] };
    return {
      entries: [],
      defect: { reason: "acceptance-report-missing", detail: `no report for ${criteriaCount} acceptance criteria` },
    };
  }
  const entries: AcceptanceReportEntry[] = [];
  let malformed = 0;
  for (const item of items) {
    const entry = toEntry(item, criteriaCount);
    if (entry) entries.push(entry);
    else malformed += 1;
  }
  const unreported: number[] = [];
  for (let n = 1; n <= criteriaCount; n++) {
    if (!entries.some((e) => e.criterion === n)) unreported.push(n);
  }
  const problems = [
    ...(unreported.length > 0 ? [`criteria not reported: ${unreported.join(", ")}`] : []),
    ...(malformed > 0 ? [`malformed entries: ${malformed}`] : []),
  ];
  if (problems.length === 0) return { entries };
  return { entries, defect: { reason: "acceptance-report-invalid", detail: problems.join("; ") } };
}
