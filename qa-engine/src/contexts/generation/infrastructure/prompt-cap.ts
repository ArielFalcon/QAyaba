/*
 * Safety bounds on free-form text a prompt carries: a commit body, the detail of a test case and a runtime message are text the
 * orchestrator does not control, so a text past its bound is cut with a marker in the text, and the section records how many were cut.
 * No cap decides how much of the commit diff or the commit body a prompt shows: they are whole while the prompt fits its role's
 * window, and over it the diff gives hunks up as `path:start-end` references (plan-diff-section.ts, `diffWindowDegrade`) and the body
 * a line that says where to read it (task-builders.ts).
 */
import { sectionPath } from "@kernel/diff-hunks.ts";

export function extractDiffFilePath(section: string): string {
  return sectionPath(section);
}

/*
 * The safety bound on one piece of runtime evidence text (a test's error, a network or console message, a contract clause): the
 * text comes out of a test run or an agent's bytes, so its size is not the orchestrator's to know. Nothing below it is cut to
 * shorten a prompt, that is the window fit rule's job; a text past it is cut with a marker in the text, and the section records
 * `EVIDENCE_SAFETY_BOUND_REASON` with how many texts were cut.
 */
export const EVIDENCE_TEXT_SAFETY_BOUND = 8_000;
export const EVIDENCE_ITEMS_SAFETY_BOUND = 50;
export const EVIDENCE_SAFETY_BOUND_REASON = "evidence-safety-bound";
const BOUNDED_MARKER = "[… cut: ";

export function boundEvidenceText(text: string, maxChars: number = EVIDENCE_TEXT_SAFETY_BOUND, what = "evidence text"): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}${BOUNDED_MARKER}${text.length - maxChars} more chars, past the safety bound on ${what}]`;
}

/* The safety bound on a commit body: prose a committer wrote, so its size is not the orchestrator's to know. Below it the body is whole; whether the window holds it is the fit rule's to say. */
export const COMMIT_BODY_SAFETY_BOUND = 8_000;

/* The line that says a list of evidence entries was cut at the safety bound on their number. */
export const evidenceItemsCutLine = (cut: number): string => `  ${BOUNDED_MARKER}${cut} more entries, past the safety bound on evidence items]`;

/* How many texts and lists of a rendered section the safety bound cut. */
export function boundedEvidenceCount(rendered: string): number {
  return rendered.split(BOUNDED_MARKER).length - 1;
}
