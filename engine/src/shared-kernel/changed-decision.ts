/*
 * A decision on the change's own changed lines, as the static listing reads it from the source text: where its head is (the
 * condition, the left operand of a logical operator, a switch's discriminant or case labels), its kind and its arms, each arm with
 * the line its own code starts on. An arm with no code of its own (the implicit else of an if, the short circuit of a logical
 * operator) has no line. The kinds and arm labels are the ones the branch measurement of a run uses for the decisions it places,
 * so a listed arm and an untaken arm read alike. Pure.
 */
import type { DiffHunk } from "./diff-parser/diff-parser.service.ts";

export type DecisionKind = "if" | "conditional" | "logical" | "switch";

export interface DecisionArm {
  label: string;
  /* The 1-based line the arm's own code starts on; absent for an arm with no code of its own. */
  line?: number;
}

export interface ChangedDecision {
  /* Repo-relative, as the diff spells it. */
  file: string;
  /* The 1-based line the decision's head starts on. */
  line: number;
  kind: DecisionKind;
  arms: DecisionArm[];
}

/* The static listing of a change: the decisions on its changed lines, and the changed files of a language with a lister that did not parse (they list nothing). */
export interface DecisionListing {
  decisions: ChangedDecision[];
  unparsed: string[];
}

const within = (decision: ChangedDecision, file: string, start: number, end: number): boolean => decision.file === file && decision.line >= start && decision.line <= end;

/* The decisions whose head is in the hunk, in line order. */
export function decisionsInHunk(decisions: readonly ChangedDecision[], hunk: Pick<DiffHunk, "file" | "newStart" | "newEnd">): ChangedDecision[] {
  return decisions.filter((d) => within(d, hunk.file, hunk.newStart, hunk.newEnd)).sort((a, b) => a.line - b.line);
}

/* The rank a slice orders hunks of one class by: a hunk holding a changed decision before the rest. */
export function decisionRankOf(decisions: readonly ChangedDecision[]): (hunk: DiffHunk) => number {
  if (decisions.length === 0) return () => 0;
  return (hunk) => (decisions.some((d) => within(d, hunk.file, hunk.newStart, hunk.newEnd)) ? 0 : 1);
}

/* One decision as a prompt states it: `file:line kind: arm (line N), arm (no code of its own)`. */
export function decisionText(decision: ChangedDecision): string {
  const arms = decision.arms.map((arm) => (arm.line === undefined ? `${arm.label} (no code of its own)` : `${arm.label} (line ${arm.line})`));
  return `${decision.file}:${decision.line} ${decision.kind}: ${arms.join(", ")}`;
}
