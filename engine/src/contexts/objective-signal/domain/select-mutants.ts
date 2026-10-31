/* Which mutants of the served script a run re-runs, and which tests each one re-runs. Pure; no I/O.
   A mutant is made only where the change is (a site on a changed line), only of the change's own code (the source line holds the expression the site mutates: what a build added beside it is no candidate, and each site left out is counted by why), and only where a test reached (a site that ran). First come the decisions of the changed lines an arm of which no test ran, each by the site that forces it (the negated condition of an if or a `?:`, the swapped operator of a `&&` or `||`): the code no test ran is what a killed mutant can prove the tests check. The rest are one per changed line, taken across the changed files in turn, so a few mutants speak of as much of the change as they can. Each re-runs the tests that ran its site: a dump is named after its test's title path, which starts with the spec file's path, so the dumps tell the spec files and the tests; when no spec file can be told from the names every spec file that passed is re-run, and when the tests cannot be told every test of the spec files is. */
import type { BranchHit, MutationSite } from "./coverage-collector.ts";
import { isDumpOfSpecFile, testOfDump } from "./dump-names.ts";
import { expressionOnSourceLine, type SiteSkipReason } from "./mutation-site-source.ts";

/* How many mutants a run re-runs: each costs a re-run of the tests that reach it against DEV. */
export const MAX_MUTANTS = 3;

/* Past this many tests a mutant's re-run is not narrowed to them: the names travel to the suite's fixture in one environment variable. */
export const MAX_RERUN_TESTS = 100;

export interface SelectedMutant {
  site: MutationSite;
  specFiles: string[];
  /* The tests whose dumps ran the site; absent when they cannot be told, and then every test of `specFiles` is re-run. */
  tests?: string[];
}

/* The sites on changed lines a test reached that are no candidate: how many, and how many for each reason. */
export interface SkippedSites {
  count: number;
  reasons: Partial<Record<SiteSkipReason, number>>;
}

export interface MutantSelection {
  mutants: SelectedMutant[];
  skipped: SkippedSites;
}

/* The text of a changed file's 1-based line, when it can be read. */
export type SourceLineOf = (file: string, line: number) => string | undefined;

/* The spec files among `caseFiles` whose tests wrote the dumps `ranIn` names; every case file when none can be told. */
export function specFilesOf(ranIn: readonly string[], caseFiles: readonly string[]): string[] {
  const files = [...new Set(caseFiles)].sort();
  const matched = files.filter((file) => ranIn.some((dump) => isDumpOfSpecFile(dump, file)));
  return matched.length > 0 ? matched : files;
}

/* The tests among the dumps `ranIn` names that are tests of `specFiles`; undefined when a dump names no test, or there are more than a re-run is narrowed to. */
function testsOf(ranIn: readonly string[], specFiles: readonly string[]): string[] | undefined {
  const tests = new Set<string>();
  for (const dump of ranIn) {
    const test = testOfDump(dump);
    if (test === undefined) return undefined;
    if (specFiles.some((file) => isDumpOfSpecFile(dump, file))) tests.add(test);
  }
  return tests.size > 0 && tests.size <= MAX_RERUN_TESTS ? [...tests].sort() : undefined;
}

/* Why `site` is no candidate, or undefined when its source line holds the expression it mutates. */
function skipReason(site: MutationSite, sourceLineOf: SourceLineOf): SiteSkipReason | undefined {
  const line = site.sourceLine ?? sourceLineOf(site.file, site.line);
  if (line === undefined) return "no-source-line";
  const swapped = /^(\S+) →/.exec(site.operator)?.[1];
  return expressionOnSourceLine({ expression: site.expression ?? site.original, ...(swapped !== undefined ? { operator: swapped } : {}) }, line) ? undefined : "not-in-source-line";
}

/* The site that forces the arms of a decision no test ran: at the decision's own place, the negation of an if's or a conditional's condition, the swap of a logical operator other than `??`. */
function forces(site: MutationSite, decision: BranchHit): boolean {
  if (site.file !== decision.file || site.line !== decision.line || site.column !== decision.column) return false;
  if (decision.kind === "if" || decision.kind === "conditional") return site.operator === "negate condition";
  return decision.kind === "logical" && /^(&&|\|\|) →/.test(site.operator);
}

/* Up to `max` mutants on the changed lines, of sites whose source line holds what they mutate: first the one that forces each decision with an arm no test ran, then one per line (its first site), taken across the changed files in turn. `sourceLineOf` reads a line for a site that carries none. */
export function selectMutants(sites: readonly MutationSite[], changed: ReadonlyMap<string, ReadonlySet<number>>, caseFiles: readonly string[], max = MAX_MUTANTS, decisions: readonly BranchHit[] = [], sourceLineOf: SourceLineOf = () => undefined): MutantSelection {
  const skipped: SkippedSites = { count: 0, reasons: {} };
  const usable = sites.filter((site) => {
    if (site.ranIn.length === 0 || !changed.get(site.file)?.has(site.line)) return false;
    const reason = skipReason(site, sourceLineOf);
    if (reason === undefined) return true;
    skipped.count++;
    skipped.reasons[reason] = (skipped.reasons[reason] ?? 0) + 1;
    return false;
  });
  const targeted: MutationSite[] = [];
  for (const decision of decisions) {
    if (targeted.length >= max) break;
    if (!changed.get(decision.file)?.has(decision.line) || decision.arms.every((arm) => arm.taken)) continue;
    const site = usable.find((s) => forces(s, decision) && !targeted.includes(s));
    if (site) targeted.push(site);
  }
  const byFile = new Map<string, MutationSite[]>();
  const seenLines = new Set(targeted.map((site) => `${site.file}:${site.line}`));
  for (const site of usable) {
    const line = `${site.file}:${site.line}`;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const list = byFile.get(site.file) ?? [];
    list.push(site);
    byFile.set(site.file, list);
  }
  const queues = [...byFile.keys()].sort().map((file) => byFile.get(file)!);
  const picked: MutationSite[] = [...targeted];
  for (let round = 0; picked.length < max && queues.some((q) => q.length > round); round++) {
    for (const queue of queues) {
      if (picked.length >= max) break;
      const site = queue[round];
      if (site) picked.push(site);
    }
  }
  const mutants = picked.map((site): SelectedMutant => {
    const specFiles = specFilesOf(site.ranIn, caseFiles);
    const told = site.ranIn.some((dump) => specFiles.some((file) => isDumpOfSpecFile(dump, file)));
    const tests = told ? testsOf(site.ranIn, specFiles) : undefined;
    return { site, specFiles, ...(tests ? { tests } : {}) };
  });
  return { mutants, skipped };
}
