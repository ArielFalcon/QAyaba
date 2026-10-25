/* Branch coverage of the changed code, from what a browser ran. The decisions are found in the script the browser ran (whatever language compiled to it: a component's template compiles to conditionals too) and placed in the repository by the script's source map, so one parser and one direction of the map serve every source language. Whether an arm ran comes from V8's block counts: an arm with code of its own ran when its block's count is above nothing; an implicit else or a short circuit ran when the decision was reached more often than its explicit arm.
   What is found is bounded like the line coverage it sits beside: a script is parsed only when it is a changed file or maps to one, once per collection however many dumps hold it, and the counts are read at the arms alone, so a dump costs the number of its ranges and of the arms of the changed files, never their product. The time the dumps are given is asked before each parse. */
import { createHash } from "node:crypto";
import ts from "typescript";
import { decodeMappings, lineStartOffsets, type TimeSpent, type V8Entry } from "./v8-browser-coverage.adapter.ts";

import type { BranchHit, BranchKind } from "../application/ports/index.ts";

/* The time the dumps are given ran out while a script's branches were read: the line coverage's own end, which leaves the whole set unused, not only the branches. */
class TimeSpentError extends Error {}
const checkTime = (spent?: TimeSpent): void => {
  if (spent?.()) throw new TimeSpentError();
};

/* How an arm is told from the counts: it ran when the count at `own` is above nothing; an arm with no code of its own ran when the count at `outer` exceeds the count at `inner`. */
type Probe = { own: number } | { outer: number; inner: number };
interface ArmProbe {
  label: string;
  probe: Probe;
}
interface ScriptDecision {
  at: number;
  kind: BranchKind;
  arms: ArmProbe[];
}
interface PlacedDecision extends ScriptDecision {
  file: string;
  line: number;
  column: number;
}

/* Past this many decisions in the changed files a collection's branches are not used: far beyond any change, and what a dump made to be costly would hold. The line coverage beside them is unaffected. */
export const MAX_BRANCH_DECISIONS = 50_000;

const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
const MAX_CASE_LABEL = 40;

/* The decisions of a script, in the order of their position. */
export function decisionsOf(source: string): ScriptDecision[] {
  const sf = ts.createSourceFile("script.js", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const out: ScriptDecision[] = [];
  const start = (node: ts.Node): number => node.getStart(sf);
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const then = start(node.thenStatement);
      out.push({
        at: start(node.expression),
        kind: "if",
        arms: [
          { label: "then", probe: { own: then } },
          { label: "else", probe: node.elseStatement ? { own: start(node.elseStatement) } : { outer: start(node), inner: then } },
        ],
      });
    } else if (ts.isConditionalExpression(node)) {
      out.push({ at: start(node.condition), kind: "conditional", arms: [{ label: "true", probe: { own: start(node.whenTrue) } }, { label: "false", probe: { own: start(node.whenFalse) } }] });
    } else if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind)) {
      const right = start(node.right);
      out.push({
        at: start(node.left),
        kind: "logical",
        arms: [
          { label: `right of ${node.operatorToken.getText(sf)} evaluated`, probe: { own: right } },
          { label: `${node.operatorToken.getText(sf)} short-circuited`, probe: { outer: start(node.left), inner: right } },
        ],
      });
    } else if (ts.isSwitchStatement(node)) {
      out.push({
        at: start(node.expression),
        kind: "switch",
        arms: node.caseBlock.clauses.map((clause) => ({
          label: ts.isCaseClause(clause) ? `case ${clause.expression.getText(sf).slice(0, MAX_CASE_LABEL)}` : "default",
          probe: { own: start(clause) },
        })),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.at - b.at);
}

/* The count V8 gives each sorted offset: the last range in V8's order that holds it decides it, and an offset no range holds did not run. Ranges are taken from the last back and each offset is decided once, skipping the decided ones, so the work is the ranges' number times the log of the offsets', plus the offsets'. */
export function countsAt(offsets: readonly number[], functions: V8Entry["functions"]): number[] {
  const counts = new Array<number>(offsets.length).fill(0);
  const ranges: Array<{ startOffset: number; endOffset: number; count: number }> = [];
  for (const fn of functions ?? []) for (const range of fn.ranges ?? []) ranges.push(range);
  const next = Array.from({ length: offsets.length + 1 }, (_, i) => i);
  const firstUndecided = (from: number): number => {
    let at = from;
    while (next[at] !== at) {
      next[at] = next[next[at]!]!;
      at = next[at]!;
    }
    return at;
  };
  const firstAtOrAfter = (offset: number): number => {
    let lo = 0;
    let hi = offsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let k = ranges.length - 1; k >= 0; k--) {
    const { startOffset, endOffset, count } = ranges[k]!;
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) continue;
    const value = typeof count === "number" && count > 0 ? count : 0;
    for (let i = firstUndecided(firstAtOrAfter(startOffset)); i < offsets.length && offsets[i]! < endOffset; i = firstUndecided(i + 1)) {
      counts[i] = value;
      next[i] = i + 1;
    }
  }
  return counts;
}

/* The decisions of a script placed in the repository: for a script that is a changed file, at its own lines; for a bundle, by the segment of its map at or before each decision on the same generated line, kept when that segment's source is a changed file. A decision no segment of its line reaches is not placed. */
function placeDecisions(decisions: ScriptDecision[], source: string, directFile: string | null, map: V8Entry["map"], files: ReadonlyArray<string | null>, spent?: TimeSpent): PlacedDecision[] {
  if (decisions.length === 0) return [];
  const starts = lineStartOffsets(source);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  if (directFile) {
    return decisions.map((d) => {
      const line = lineOf(d.at);
      return { ...d, file: directFile, line: line + 1, column: d.at - starts[line]! };
    });
  }
  if (!map) return [];
  const placed: PlacedDecision[] = [];
  let next = 0;
  let last: { genLine: number; genCol: number; sourceIndex: number; origLine: number; origCol: number } | undefined;
  let segments = 0;
  const placeUpTo = (genLine: number, genCol: number): void => {
    while (next < decisions.length) {
      const d = decisions[next]!;
      const line = lineOf(d.at);
      const col = d.at - starts[line]!;
      if (line > genLine || (line === genLine && col >= genCol)) return;
      if (last && last.genLine === line) {
        const file = files[last.sourceIndex];
        if (file) placed.push({ ...d, file, line: last.origLine + 1, column: last.origCol });
      }
      next++;
    }
  };
  for (const seg of decodeMappings(map.mappings)) {
    if (++segments % 4096 === 0) checkTime(spent);
    placeUpTo(seg.genLine, seg.genCol);
    last = seg;
  }
  placeUpTo(Number.MAX_SAFE_INTEGER, 0);
  return placed;
}

/* The decisions of the changed files across the dumps of a collection: each script parsed and placed once, each dump's counts read at its arms, an arm taken in any dump taken. Decisions of the same place in two scripts (a chunk two bundles share) are one. A script it cannot read within its bounds leaves the collection's branches unused (`result()` is undefined) and never the line coverage: the time the dumps are given is the line coverage's, which ends the whole set when it is spent. */
export class BranchSink {
  private readonly placedByScript = new Map<string, PlacedDecision[]>();
  private readonly hits = new Map<string, BranchHit>();
  private abandoned = false;

  /* Adds what one script of one dump says of the changed files' decisions. */
  add(entry: V8Entry, directFile: string | null, files: ReadonlyArray<string | null>, spent?: TimeSpent): void {
    if (this.abandoned) return;
    try {
      this.addScript(entry, directFile, files, spent);
    } catch (err) {
      if (err instanceof TimeSpentError) throw err;
      this.abandoned = true;
      this.placedByScript.clear();
      this.hits.clear();
    }
  }

  private addScript(entry: V8Entry, directFile: string | null, files: ReadonlyArray<string | null>, spent?: TimeSpent): void {
    const source = entry.source!;
    const key = createHash("sha256").update(source).update("\0").update(directFile ?? "").update("\0").update(entry.map?.mappings ?? "").update("\0").update(files.join("\0")).digest("hex");
    let placed = this.placedByScript.get(key);
    if (!placed) {
      checkTime(spent);
      placed = placeDecisions(decisionsOf(source), source, directFile, entry.map, files, spent);
      this.placedByScript.set(key, placed);
      let total = 0;
      for (const p of this.placedByScript.values()) total += p.length;
      if (total > MAX_BRANCH_DECISIONS) throw new RangeError();
    }
    if (placed.length === 0) return;
    const offsets = [...new Set(placed.flatMap((d) => d.arms.flatMap((a) => ("own" in a.probe ? [a.probe.own] : [a.probe.outer, a.probe.inner]))))].sort((a, b) => a - b);
    const counts = countsAt(offsets, entry.functions);
    const countAt = new Map(offsets.map((offset, i) => [offset, counts[i]!]));
    const count = (offset: number): number => countAt.get(offset) ?? 0;
    for (const d of placed) {
      const id = `${d.file}:${d.line}:${d.column}:${d.kind}`;
      const taken = d.arms.map((a) => ("own" in a.probe ? count(a.probe.own) > 0 : count(a.probe.outer) > count(a.probe.inner)));
      const known = this.hits.get(id);
      if (!known) {
        this.hits.set(id, { file: d.file, line: d.line, column: d.column, kind: d.kind, arms: d.arms.map((a, i) => ({ label: a.label, taken: taken[i]! })) });
      } else if (known.arms.length === taken.length) {
        known.arms.forEach((arm, i) => {
          arm.taken ||= taken[i]!;
        });
      }
    }
  }

  /* The decisions found, in file and position order; undefined when a script could not be read within the bounds. */
  result(): BranchHit[] | undefined {
    if (this.abandoned) return undefined;
    return [...this.hits.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  }
}
