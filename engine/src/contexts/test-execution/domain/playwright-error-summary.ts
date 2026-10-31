/*
 * The compact form of a Playwright failure for a span: the first non-empty line, the assertion labels Playwright lays out under it and
 * the start of the call log. It strips ANSI, never includes a stack and is capped, so a span's exception carries the real reason for a
 * failed test without the whole multi-screen message. Pure.
 */

import { stripAnsi } from "@kernel/ansi.ts";

const CAP_CHARS = 500;
/* A labelled line of a Playwright failure, at line start. "Expected"/"Received" admit Playwright's modifiers ("string", "value", …). */
const LABELS = ["Locator:", "Expected", "Received", "Timeout:"] as const;
const CALL_LOG_LINE = "Call log:";
/* A top-level call-log entry; a nested sub-line is indented further. */
const CALL_LOG_ENTRY = "  - ";
const CALL_LOG_ENTRIES_MAX = 2;

export function summarizePlaywrightFailure(message: string): string {
  const lines = stripAnsi(message).split("\n");
  const kept: string[] = [];
  let callLogAt = -1;
  let first = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith(CALL_LOG_LINE)) {
      callLogAt = i;
      continue;
    }
    if (!first && line.trim() !== "") {
      kept.push(line.trimEnd());
      first = true;
      continue;
    }
    if (LABELS.some((label) => line.startsWith(label))) kept.push(line.trimEnd());
  }
  if (callLogAt >= 0) {
    let entries = 0;
    for (let i = callLogAt + 1; i < lines.length && entries < CALL_LOG_ENTRIES_MAX; i += 1) {
      const line = lines[i]!;
      if (line.startsWith(CALL_LOG_ENTRY)) {
        kept.push(line.trimEnd());
        entries += 1;
      }
    }
  }
  const summary = kept.join("\n");
  return summary.length > CAP_CHARS ? summary.slice(0, CAP_CHARS) : summary;
}
