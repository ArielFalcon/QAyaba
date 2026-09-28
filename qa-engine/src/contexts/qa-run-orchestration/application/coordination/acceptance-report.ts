/*
 * The sidekick's typed per-criterion acceptance report. The brief numbers its acceptance criteria
 * from 1 and the sidekick reports every one of them by that number. Reading fails closed: an absent
 * or malformed report is a contract defect, never read as "met" — a criterion without a well-formed
 * entry stays unverified — and an unmet the sidekick reports blocks in any shape it takes.
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
  /** Every unmet the report states outside a kept entry, named by the criterion as the sidekick wrote it. */
  readonly unmet: readonly string[];
}

export interface AcceptanceReport {
  readonly entries: readonly AcceptanceReportEntry[];
  readonly defect?: AcceptanceReportDefect;
}

type ReportItem = Record<string, unknown>;

/* The report's items. A keyed object ({"1": "unmet"}) is not the contract's shape: each key becomes a
   string criterion no entry accepts, so no criterion is read as met while its unmet values still count. */
function reportItems(raw: unknown): readonly ReportItem[] {
  /* A primitive item destructures to undefined fields; only null/undefined cannot. */
  if (Array.isArray(raw)) return raw.map((item: unknown) => (item ?? {}) as ReportItem);
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([criterion, value]: [string, unknown]) => ({
    criterion,
    status: typeof value === "string" ? value : ((value ?? {}) as ReportItem).status,
  }));
}

function isUnmet(status: unknown): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "unmet";
}

function toEntry({ criterion, status, note }: ReportItem, criteriaCount: number): AcceptanceReportEntry | undefined {
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
  const items = reportItems(raw);
  if (items.length === 0) {
    if (criteriaCount === 0) return { entries: [] };
    return {
      entries: [],
      defect: { reason: "acceptance-report-missing", detail: `no report for ${criteriaCount} acceptance criteria`, unmet: [] },
    };
  }
  /* A whole number outside 1..criteriaCount means the report numbers the criteria its own way (0-based,
     another list): no entry can be matched to the brief's criterion, so none is kept. */
  const misnumbered = items.some(
    ({ criterion }) => Number.isInteger(criterion) && ((criterion as number) < 1 || (criterion as number) > criteriaCount),
  );
  const entries: AcceptanceReportEntry[] = [];
  const unmet: string[] = [];
  let malformed = 0;
  for (const item of items) {
    const entry = toEntry(item, criteriaCount);
    if (!entry) malformed += 1;
    if (entry && !misnumbered) entries.push(entry);
    else if (isUnmet(item.status)) unmet.push(scrub(`criterion ${JSON.stringify(item.criterion)}`));
  }
  const unreported: number[] = [];
  for (let n = 1; n <= criteriaCount; n++) {
    if (!entries.some((e) => e.criterion === n)) unreported.push(n);
  }
  const problems = [
    ...(unreported.length > 0 ? [`criteria not reported: ${unreported.join(", ")}`] : []),
    ...(malformed > 0 ? [`malformed entries: ${malformed}`] : []),
    ...unmet.map((claim) => `reported unmet: ${claim}`),
  ];
  if (problems.length === 0) return { entries };
  return { entries, defect: { reason: "acceptance-report-invalid", detail: problems.join("; "), unmet } };
}
