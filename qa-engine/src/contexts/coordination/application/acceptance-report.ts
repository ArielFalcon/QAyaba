/*
 * The sidekick's typed per-criterion acceptance report. The brief numbers its acceptance criteria
 * from 1 and the sidekick reports every one of them by that number. Reading fails closed: an absent
 * or malformed report is a contract defect, never read as "met" — a criterion without a well-formed
 * entry stays unverified — and an unmet the sidekick reports blocks in any shape it takes.
 */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";

export const ACCEPTANCE_STATUSES = ["met", "unmet", "unverified"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

/* Why a criterion is unmet, when the sidekick attributes it to something other than its own work. Only `dev-state` is typed: DEV
   cannot be brought to the state the criterion needs. The attribution is a claim; the orchestrator holds it to its own facts. */
export const UNMET_CAUSES = { DEV_STATE: "dev-state" } as const;

/* The caps on a DEV-state claim: it names the pages where DEV's state prevents the criterion, a handful at most. */
export const MAX_DEV_STATE_PAGES = 8;
const MAX_DEV_STATE_PAGE_CHARS = 200;

export interface AcceptanceReportEntry {
  /** 1-based number of the criterion as the brief lists it. */
  readonly criterion: number;
  readonly status: AcceptanceStatus;
  readonly note?: string;
  /** An `unmet` entry's claim that DEV's state prevents the criterion, with the pages (paths) where the sidekick read that state. */
  readonly devState?: { readonly pages: readonly string[] };
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

/* A whole-number criterion and a known status; whether the number is one of the brief's is decided for
   the report as a whole. */
/* A well-formed DEV-state claim of an unmet entry: the typed cause and at least one page, each scrubbed and capped; nothing for any other shape. */
function devStateOf(redaction: RedactionPort, status: string, cause: unknown, pages: unknown): { devState?: { pages: string[] } } {
  if (status !== "unmet" || cause !== UNMET_CAUSES.DEV_STATE || !Array.isArray(pages)) return {};
  const named = pages
    .filter((page): page is string => typeof page === "string" && page.trim() !== "" && page.length <= MAX_DEV_STATE_PAGE_CHARS)
    .map((page) => redaction.redact(page.trim()));
  const kept = [...new Set(named)].slice(0, MAX_DEV_STATE_PAGES);
  return kept.length > 0 ? { devState: { pages: kept } } : {};
}

function toEntry(redaction: RedactionPort, { criterion, status, note, cause, pages }: ReportItem): AcceptanceReportEntry | undefined {
  if (typeof criterion !== "number" || !Number.isInteger(criterion)) return undefined;
  if (typeof status !== "string" || !(ACCEPTANCE_STATUSES as readonly string[]).includes(status)) return undefined;
  return {
    criterion,
    status: status as AcceptanceStatus,
    ...(typeof note === "string" ? { note: redaction.redact(note) } : {}),
    ...devStateOf(redaction, status, cause, pages),
  };
}

/* Reads the raw `acceptance` value of a sidekick answer against a brief with `criteriaCount` criteria. */
export function readAcceptanceReport(redaction: RedactionPort, raw: unknown, criteriaCount: number): AcceptanceReport {
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
  const outside = items
    .map(({ criterion }) => criterion)
    .filter((criterion) => Number.isInteger(criterion) && ((criterion as number) < 1 || (criterion as number) > criteriaCount));
  const entries: AcceptanceReportEntry[] = [];
  const unmet: string[] = [];
  let malformed = 0;
  for (const item of items) {
    const entry = toEntry(redaction, item);
    if (!entry) malformed += 1;
    if (entry && outside.length === 0) entries.push(entry);
    else if (isUnmet(item.status)) unmet.push(redaction.redact(`criterion ${JSON.stringify(item.criterion)}`));
  }
  const unreported: number[] = [];
  for (let n = 1; n <= criteriaCount; n++) {
    if (!entries.some((e) => e.criterion === n)) unreported.push(n);
  }
  const problems = [
    ...(unreported.length > 0 ? [`criteria not reported: ${unreported.join(", ")}`] : []),
    ...outside.map((criterion) => `criterion ${criterion} is outside 1..${criteriaCount}`),
    ...(malformed > 0 ? [`malformed entries: ${malformed}`] : []),
    ...unmet.map((claim) => `reported unmet: ${claim}`),
  ];
  if (problems.length === 0) return { entries };
  return { entries, defect: { reason: "acceptance-report-invalid", detail: problems.join("; "), unmet } };
}
