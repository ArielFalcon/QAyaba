/*
 * Safety bounds on free-form prose a prompt carries: a commit body and the detail of a test case are text the orchestrator does not
 * control, so capText cuts them at a fixed length and says so in the text. No cap decides how much of the commit diff a prompt
 * shows: the diff is whole while the prompt fits its role's window, and over it gives hunks up as `path:start-end` references
 * (plan-diff-section.ts, `diffWindowDegrade`).
 */
import { sectionPath } from "@kernel/diff-hunks.ts";

export function extractDiffFilePath(section: string): string {
  return sectionPath(section);
}

export const MAX_PROMPT_BODY_CHARS = 4_000;

export function capText(text: string, maxChars: number = MAX_PROMPT_BODY_CHARS): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n[…body truncated: ${text.length - maxChars} more chars; read the full message with \`git show <sha>\`.]`
  );
}
