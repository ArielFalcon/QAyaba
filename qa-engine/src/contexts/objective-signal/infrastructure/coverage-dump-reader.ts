/* Coverage dump reader. Fail-open: an absent, unusable or corrupt dump degrades to an empty result — never throws, never waits, never leaves the mirror. An empty report is unmeasured → unknown → never blocks publish. What a run of the tests leaves is the agent's to shape, so every read goes through run-output-reader (the strict read under a cap; what cannot be used is said aloud, quoting nothing of it). The dumps of a run are used whole or not at all: the coverage of some of them is a ratio of a part of what the run did, lower than the real one, and under enforce it would block a valid change, so when any of them cannot be used none of them is used and the result is empty. */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { join } from "node:path";
import type { CoverageScripts, MutantEdit } from "../domain/coverage-collector.ts";
import { undoMutant } from "./undo-mutant.ts";
import { MAX_V8_DUMP_BYTES, MAX_V8_DUMP_FILES, MAX_V8_DUMPS_TOTAL_BYTES } from "../domain/dump-sanitizers.ts";
import { defaultParseV8Coverage, type CoveredLines, type TimeSpent, type V8Entry } from "./v8-browser-coverage.adapter.ts";
import type { BranchSink } from "./v8-branch-coverage.ts";
import { readRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";

export const V8_DUMP_LIMITS: RunOutputLimits = { maxFileBytes: MAX_V8_DUMP_BYTES, maxTotalBytes: MAX_V8_DUMPS_TOTAL_BYTES, maxFiles: MAX_V8_DUMP_FILES };

/* The time all the dumps of a run are given to be parsed and decoded, together: a suite of fifty dumps of the largest size measured is some ten seconds at the speed it ran at, and a hundred megabytes of the slowest map is five. Past it the set is unused. */
export const V8_DECODE_BUDGET_MS = 10_000;

/* The clock the budget is kept by (a monotonic one: a change of the wall clock cannot spend it or give it back); a test hands one that it moves. */
export interface V8DecodeTime {
  now(): number;
  budgetMs: number;
}
const REAL_TIME: V8DecodeTime = { now: () => performance.now(), budgetMs: V8_DECODE_BUDGET_MS };

/* What a dump covers of the changed files; throws on a dump it cannot decode within its bounds or before the time `spent` speaks of is, which leaves the set unused. */
type ParseV8 = (entries: V8Entry[], changedFiles: string[], spent?: TimeSpent, scripts?: CoverageScripts, branches?: BranchSink, executable?: CoveredLines) => CoveredLines;

/* The lines of `changedFiles` that the dumps of a namespace cover (and, in `scripts` when given, how many scripts they held and how many carried a source map; in `branches`, the decisions of the changed files they ran), one entry per dump in the order of their names; in `ranBy`, when given, the names of the dumps that ran a line of each changed file, added only when the set is used. Each dump is parsed and reduced inside its read, so the dump itself is garbage as soon as the next one is read: the result is as small as the lines of the changed files, however many dumps and however large. A dump `keep` refuses (by its name) is neither read nor parsed; a dump a mutant's re-run wrote (`mutant`) is read with the mutant's edit undone. The time starts with the first dump; a dump that finds it spent is not even parsed, and a decoding that finds it spent stops: either leaves the set unused, said once with the reason. */
export async function readV8Coverage(e2eDir: string, namespace: string, changedFiles: string[], limits: RunOutputLimits = V8_DUMP_LIMITS, parse: ParseV8 = defaultParseV8Coverage, time: V8DecodeTime = REAL_TIME, scripts?: CoverageScripts, branches?: BranchSink, keep: (name: string) => boolean = () => true, executable?: CoveredLines, mutant?: MutantEdit, ranBy?: Map<string, Set<string>>): Promise<CoveredLines[]> {
  const rel = `.qa/coverage/${namespace}`;
  const startedAt = time.now();
  let ranOutOfTime = false;
  const named: Array<[string, CoveredLines]> = [];
  const spent = (): boolean => {
    if (time.now() - startedAt <= time.budgetMs) return false;
    ranOutOfTime = true;
    return true;
  };
  const dumps = readRunOutputDir(
    { mirrorDir: e2eDir, specDir: e2eDir },
    rel,
    (name) => name.endsWith(".json") && keep(name),
    (name, bytes) => {
      if (spent()) throw new RangeError();
      branches?.beginDump(name);
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      const entries = Array.isArray(parsed) ? (parsed as V8Entry[]) : [];
      const covered = parse(mutant ? undoMutant(entries, mutant) : entries, changedFiles, spent, scripts, branches, executable);
      named.push([name, covered]);
      return covered;
    },
    limits,
  );
  /* The dumps are used whole or not at all: which ran what is told only of a set that is used. */
  if (dumps && ranBy) {
    for (const [name, covered] of named) {
      for (const [file, lines] of covered) if (lines.size > 0) ranBy.set(file, (ranBy.get(file) ?? new Set<string>()).add(name));
    }
  }
  if (ranOutOfTime) engineLog.warn(`[qa] WARNING: ${join(e2eDir, rel)}: the dumps were not all decoded in the time a run is given (${time.budgetMs} ms); none of them is used, so the coverage is unknown this run (non-blocking).`);
  return dumps ?? [];
}
