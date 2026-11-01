import { CorrectionEntrySchema, ReviewerVerdictSchema, type CorrectionEntry } from "./verdict-schemas.ts";
import { GRAVE_TAGS } from "@kernel/error-class.ts";
import { submissionErrorsOf, type SubmissionError } from "@kernel/submission.ts";


/*
 * Extract a correction's leading [class-tag] (lowercased), or null when it carries none.
 * Mirrors the tag grammar in taxonomy.ts classifyReviewerCorrection.
 */
function leadingClassTag(text: string): string | null {
  return /^\s*\[([a-z][a-z-]*)\]/i.exec(text)?.[1]?.toLowerCase() ?? null;
}


/* The reviewer's finding as the decision reads it: a grave class tag raises the severity the agent stated, and a null citation is no citation. */
function effectiveFinding(entry: CorrectionEntry): ReviewerFinding {
  const tag = leadingClassTag(entry.text);
  const severity = tag && GRAVE_TAGS.has(tag) ? "blocking" : entry.severity;
  return { text: entry.text, severity, ...(entry.citation ? { citation: entry.citation } : {}) };
}

/* A finding as the decision reads it: the citation is absent when the agent cited nothing. */
export type ReviewerFinding = Omit<CorrectionEntry, "citation"> & { citation?: NonNullable<CorrectionEntry["citation"]> };

export interface ReviewerVerdict {
  approved: boolean;
  rationale?: string;
  /* Every finding the agent wrote, each with its effective severity and the evidence it cites; a finding with no citation is one the agent left uncited. */
  findings: ReviewerFinding[];
  blockingCount: number;
  valid: boolean;  /* the submission satisfied the schema: every field the engine reads was readable */
  parsed: boolean;  /* an object carrying an `approved` field was submitted at all */
  /* What the engine could not read (an unreadable submission) or read and set aside (corrections beside an approval that are not a list, or entries of it that cannot be read); empty when nothing was lost. */
  issues: SubmissionError[];
}

/* The reviewer's submission as the decision reads it: a submission the schema cannot read whole is invalid, and says where. */
export function readReviewerVerdict(answer: unknown): ReviewerVerdict {
  const candidate = typeof answer === "object" && answer !== null && !Array.isArray(answer) ? (answer as Record<string, unknown>) : undefined;
  if (!candidate || !("approved" in candidate)) {
    return {
      approved: false,
      findings: [],
      blockingCount: 0,
      valid: false,
      parsed: false,
      issues: [{ path: "approved", reason: "the submission carries no `approved` field" }],
    };
  }
  /* An approval does not depend on its list of corrections: a list that is not one is read as none, and an entry the schema cannot read is set aside; both are recorded. A rejection without a readable list is unreadable. */
  const approval = candidate.approved === true ? readApprovalCorrections(candidate.corrections) : undefined;
  const r = ReviewerVerdictSchema.safeParse(approval ? { ...candidate, corrections: approval.entries } : candidate);
  if (!r.success) {
    return { approved: false, findings: [], blockingCount: 0, valid: false, parsed: true, issues: submissionErrorsOf(r.error) };
  }
  const findings = r.data.corrections.map(effectiveFinding);
  return {
    approved: r.data.approved,
    ...(r.data.rationale && r.data.rationale.trim() ? { rationale: r.data.rationale.trim() } : {}),
    findings,
    blockingCount: findings.filter((f) => f.severity === "blocking").length,
    valid: true,
    parsed: true,
    issues: approval?.issues ?? [],
  };
}

/* The corrections beside an approval: the entries the schema reads, and what was set aside as "path: message". Absent corrections lose nothing. */
function readApprovalCorrections(corrections: unknown): { entries: CorrectionEntry[]; issues: SubmissionError[] } {
  if (corrections === undefined) return { entries: [], issues: [] };
  if (!Array.isArray(corrections)) return { entries: [], issues: [{ path: "corrections", reason: "not a list; read as none beside an approval" }] };
  const entries: CorrectionEntry[] = [];
  const issues: SubmissionError[] = [];
  corrections.forEach((raw: unknown, index) => {
    const entry = CorrectionEntrySchema.safeParse(raw);
    if (entry.success) entries.push(entry.data);
    else issues.push(...submissionErrorsOf(entry.error, ["corrections", String(index)]));
  });
  return { entries, issues };
}
