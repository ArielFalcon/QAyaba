import type { UntakenArm } from "./objective-signal.ts";

/* A decision on a changed line with the arms of it no test ran: its identity is its file, line, column and kind. */
export interface UntakenDecision {
  file: string;
  line: number;
  column: number;
  kind: string;
  arms: string[];
  /** The spec files that evaluated the decision, as its arms carry them. */
  evaluatedBy?: string[];
}

/* The untaken arms gathered by the decision they belong to, in the order the decisions first appear. */
export function untakenDecisions(arms: readonly UntakenArm[]): UntakenDecision[] {
  const decisions = new Map<string, UntakenDecision>();
  for (const { file, line, column, kind, arm, evaluatedBy } of arms) {
    const key = `${file}:${line}:${column}:${kind}`;
    const known = decisions.get(key);
    if (known) known.arms.push(arm);
    else decisions.set(key, { file, line, column, kind, arms: [arm], ...(evaluatedBy ? { evaluatedBy } : {}) });
  }
  return [...decisions.values()];
}

/* Where a decision is (1-based line and column), its kind and the arms no test ran. */
export function renderUntakenDecision({ file, line, column, kind, arms }: UntakenDecision): string {
  return `${file}:${line}:${column + 1} ${kind}: ${arms.join("; ")}`;
}
