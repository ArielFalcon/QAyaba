/* Branch coverage of the changed code, and the places a mutant of it can be made, from what a browser ran. The decisions are found in the script the browser ran (whatever language compiled to it: a component's template compiles to conditionals too) and placed in the repository by the script's source map, so one parser and one direction of the map serve every source language. Whether an arm ran comes from V8's block counts: an arm with code of its own ran when its block's count is above nothing; an implicit else or a short circuit ran when the decision was reached more often than its explicit arm.
   What is found is bounded like the line coverage it sits beside: a script is parsed only when it is a changed file or maps to one, once per collection however many dumps hold it, and the counts are read at the arms alone, so a dump costs the number of its ranges and of the arms of the changed files, never their product. The time the dumps are given is asked before each parse.
   A mutation site is a decision's condition (negated) or a comparison or logical operator (swapped) in the generated script, placed the same way; it carries the exact edit of the served script and the dumps (tests) that ran it, so a mutant re-runs only the tests that reach it. */
import { createHash } from "node:crypto";
import ts from "typescript";
import { decodeMappings, lineStartOffsets, type TimeSpent, type V8Entry } from "./v8-source-map.ts";

import type { BranchHit, BranchKind, MutationSite } from "../domain/coverage-collector.ts";

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
/* An edit of the generated script that inverts what a decision or a comparison of it does. */
interface ScriptSite {
  at: number;
  operator: string;
  start: number;
  end: number;
  replacement: string;
}
type Placed<T> = T & { file: string; line: number; column: number };
interface PlacedScript {
  sha256: string;
  decisions: Placed<ScriptDecision>[];
  sites: Placed<ScriptSite>[];
}

/* Past this many decisions in the changed files a collection's branches are not used: far beyond any change, and what a dump made to be costly would hold. The line coverage beside them is unaffected. */
export const MAX_BRANCH_DECISIONS = 50_000;

const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
const MAX_CASE_LABEL = 40;
/* A negated condition is carried whole in the mutant; past this length the condition is no site. */
export const MAX_MUTANT_TEXT = 400;
const SWAPPED_OPERATOR: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
  [ts.SyntaxKind.EqualsEqualsToken, "!="],
  [ts.SyntaxKind.ExclamationEqualsToken, "=="],
  [ts.SyntaxKind.LessThanToken, "<="],
  [ts.SyntaxKind.LessThanEqualsToken, "<"],
  [ts.SyntaxKind.GreaterThanToken, ">="],
  [ts.SyntaxKind.GreaterThanEqualsToken, ">"],
  [ts.SyntaxKind.AmpersandAmpersandToken, "||"],
  [ts.SyntaxKind.BarBarToken, "&&"],
]);

/* The decisions and the mutation sites of a script, each in the order of its position. */
export function analyzeScript(source: string): { decisions: ScriptDecision[]; sites: ScriptSite[] } {
  const sf = ts.createSourceFile("script.js", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const out: ScriptDecision[] = [];
  const sites: ScriptSite[] = [];
  const start = (node: ts.Node): number => node.getStart(sf);
  const negate = (condition: ts.Expression): void => {
    const text = source.slice(start(condition), condition.end);
    if (text.length <= MAX_MUTANT_TEXT) sites.push({ at: start(condition), operator: "negate condition", start: start(condition), end: condition.end, replacement: `!(${text})` });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const swapped = SWAPPED_OPERATOR.get(node.operatorToken.kind);
      if (swapped) {
        /* The site ran when its expression did: V8 opens the range of a logical right side at the operator itself, so the operator's own count is the right side's. */
        const operator = start(node.operatorToken);
        sites.push({ at: start(node), operator: `${node.operatorToken.getText(sf)} → ${swapped}`, start: operator, end: node.operatorToken.end, replacement: swapped });
      }
    }
    if (ts.isIfStatement(node)) negate(node.expression);
    else if (ts.isConditionalExpression(node)) negate(node.condition);
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
  return { decisions: out.sort((a, b) => a.at - b.at), sites: sites.sort((a, b) => a.at - b.at) };
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

/* What of a script is placed in the repository, sorted by position: for a script that is a changed file, at its own lines; for a bundle, by the segment of its map at or before each item on the same generated line, kept when that segment's source is a changed file. An item no segment of its line reaches is not placed. */
function place<T extends { at: number }>(decisions: readonly T[], source: string, directFile: string | null, map: V8Entry["map"], files: ReadonlyArray<string | null>, spent?: TimeSpent): Placed<T>[] {
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
  const placed: Placed<T>[] = [];
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
  private readonly placedByScript = new Map<string, PlacedScript>();
  private readonly hits = new Map<string, BranchHit>();
  private readonly sites = new Map<string, MutationSite>();
  private abandoned = false;
  private dump = "";

  /* Names the dump whose scripts are added next: a mutation site records the dumps that ran it. */
  beginDump(name: string): void {
    this.dump = name;
  }

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
      this.sites.clear();
    }
  }

  private addScript(entry: V8Entry, directFile: string | null, files: ReadonlyArray<string | null>, spent?: TimeSpent): void {
    const source = entry.source!;
    const key = createHash("sha256").update(source).update("\0").update(directFile ?? "").update("\0").update(entry.map?.mappings ?? "").update("\0").update(files.join("\0")).digest("hex");
    let placed = this.placedByScript.get(key);
    if (!placed) {
      checkTime(spent);
      const { decisions, sites } = analyzeScript(source);
      placed = {
        sha256: createHash("sha256").update(source).digest("hex"),
        decisions: place(decisions, source, directFile, entry.map, files, spent),
        sites: place(sites, source, directFile, entry.map, files, spent),
      };
      this.placedByScript.set(key, placed);
      let total = 0;
      for (const p of this.placedByScript.values()) total += p.decisions.length + p.sites.length;
      if (total > MAX_BRANCH_DECISIONS) throw new RangeError();
    }
    if (placed.decisions.length === 0 && placed.sites.length === 0) return;
    const offsets = [...new Set([...placed.decisions.flatMap((d) => d.arms.flatMap((a) => ("own" in a.probe ? [a.probe.own] : [a.probe.outer, a.probe.inner]))), ...placed.sites.map((site) => site.at)])].sort((a, b) => a - b);
    const counts = countsAt(offsets, entry.functions);
    const countAt = new Map(offsets.map((offset, i) => [offset, counts[i]!]));
    const count = (offset: number): number => countAt.get(offset) ?? 0;
    for (const site of placed.sites) {
      if (count(site.at) === 0) continue;
      const id = `${entry.url}\0${placed.sha256}\0${site.start}\0${site.end}\0${site.replacement}`;
      const known = this.sites.get(id);
      if (known) {
        if (!known.ranIn.includes(this.dump)) known.ranIn.push(this.dump);
      } else {
        this.sites.set(id, { file: site.file, line: site.line, column: site.column, operator: site.operator, script: { url: entry.url!, sha256: placed.sha256 }, edit: { start: site.start, end: site.end, replacement: site.replacement }, ranIn: [this.dump] });
      }
    }
    for (const d of placed.decisions) {
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

  /* The mutation sites of the changed files that ran in at least one dump, in file and position order; undefined when a script could not be read within the bounds. */
  mutationSites(): MutationSite[] | undefined {
    if (this.abandoned) return undefined;
    return [...this.sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.operator.localeCompare(b.operator));
  }

  /* The decisions found, in file and position order; undefined when a script could not be read within the bounds. */
  result(): BranchHit[] | undefined {
    if (this.abandoned) return undefined;
    return [...this.hits.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  }
}
