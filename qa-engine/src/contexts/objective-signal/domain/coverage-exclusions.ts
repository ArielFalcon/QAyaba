/*
 * Changed files whose uncovered lines are not a gap of the suite, decided from the run's facts and never by name:
 *   - `unreachableByDesign`: a file a web run cannot load because the change itself made every route that reaches it unavailable
 *     (the route-availability classification `change-introduced`: the change's own redirect, such as a route open to native
 *     clients only). Every changed symbol of the file must itself reach a use case (a map-linked whole-file seed names no symbol and
 *     vouches for none), every use case it reaches must be such a page, no symbol of it may be partial or pruned at a hub, and every
 *     changed line of the file must lie inside one of those symbols' ranges (a changed top-level statement belongs to no symbol and
 *     runs whenever the file loads): anything less keeps the file counted.
 *   - `testSupportFiles`: a file that only test files use (a helper, a fixture, a builder). The code graph says who uses it three
 *     ways (import edges, edges of any kind, references it could not resolve that name it) and which files load modules by a name
 *     it cannot resolve; one user that is not a test file, a dynamic loader that is not a test file, or a list that is empty, cut or
 *     unread, keeps it counted: an import edge alone misses a lazy `import()` and a same-package class.
 * Both are recorded apart with why, and the files leave the measurement whole: their lines, branches and mutants alike. Pure.
 */
import { LanguageRegistry } from "@kernel/language-id.ts";
import { diffGitHeaderPath } from "@kernel/diff-parser/diff-parser.service.ts";
import { FILE_SEED_SYMBOL, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { AVAILABILITY_CLASS, factForRoute, type RouteAvailabilityFact } from "@kernel/route-availability.ts";
import type { ImportersReport } from "@kernel/code/index.ts";
import { parseDiffHunks } from "./assemble-change-coverage.ts";
import { diffWithoutTestFiles } from "./diff-without-test-files.ts";

/* A file only reached through routes the change made unavailable, and those routes. */
export interface UnreachableByDesign {
  file: string;
  routes: string[];
}

/* A file only test files import, and how many do. */
export interface TestSupportFile {
  file: string;
  importers: number;
}

export interface CoverageExclusions {
  unreachableByDesign: UnreachableByDesign[];
  testSupportFiles: TestSupportFile[];
}

/* The part of the run's change scope the reading needs; `ChangeScope` satisfies it. */
export interface ReachScope {
  repos: ReadonlyArray<{ seeds: ReadonlyArray<{ file: string; symbol: string; range?: { start: number; end: number } }> }>;
  hubs: ReadonlyArray<{ symbol: string; seeds?: readonly string[] }>;
  /* Reach entries the scope's limit cut: any of them may be an available page. */
  omitted: number;
  partialSeeds?: readonly string[];
  degraded: ReadonlyArray<unknown>;
}

const seedKey = (s: { file: string; symbol: string }): string => `${s.file}::${s.symbol}`;

/* The changed files a coverage measurement can count: the commit's own code files (a declared language, not a test file). */
export function changedCodeFiles(diff: string): string[] {
  return [...parseDiffHunks(diffWithoutTestFiles(diff).diff).keys()].filter((file) => LanguageRegistry.languageForFile(file) !== null);
}

export interface UnreachableInput {
  files: readonly string[];
  /* The commit's diff: the changed lines of each file, which the symbols' ranges must cover. */
  diff: string;
  scope: ReachScope | undefined;
  candidates: readonly UseCaseCandidate[];
  facts: readonly RouteAvailabilityFact[];
}

/* The files of `files` a web run cannot load by the change's own design; a file the facts do not settle is not among them. */
export function unreachableByDesign(input: UnreachableInput): UnreachableByDesign[] {
  const { scope, candidates, facts } = input;
  if (scope === undefined || scope.degraded.length > 0 || scope.omitted > 0) return [];
  const byDesign = (route: string): boolean => factForRoute(facts, route)?.basis.class === AVAILABILITY_CLASS.CHANGE_INTRODUCED;
  const partial = new Set(scope.partialSeeds ?? []);
  const pruned = new Set(scope.hubs.flatMap((hub) => [hub.symbol, ...(hub.seeds ?? [])]));
  const changedLines = parseDiffHunks(diffWithoutTestFiles(input.diff).diff);
  const out: UnreachableByDesign[] = [];
  for (const file of input.files) {
    const touching = candidates.filter((c) => [...c.seeds, ...(c.sharedSeeds ?? [])].some((s) => s.file === file));
    if (touching.length === 0) continue;
    if (!touching.every((c) => c.entry.kind === "page" && byDesign(c.entry.route))) continue;
    /* A symbol is vouched for only by a seed that names it: the whole-file seed of a map link stands for no symbol. */
    const reached = new Set(touching.flatMap((c) => c.seeds.filter((s) => s.file === file && s.symbol !== FILE_SEED_SYMBOL).map(seedKey)));
    const seeds = scope.repos.flatMap((repo) => repo.seeds).filter((s) => s.file === file);
    if (seeds.some((s) => partial.has(seedKey(s)) || pruned.has(seedKey(s)) || !reached.has(seedKey(s)))) continue;
    const ranges = seeds.flatMap((s) => (s.range ? [s.range] : []));
    const lines = changedLines.get(file);
    if (lines === undefined || lines.size === 0 || ![...lines].every((line) => ranges.some((r) => r.start <= line && line <= r.end))) continue;
    out.push({ file, routes: [...new Set(touching.flatMap((c) => (c.entry.kind === "page" ? [c.entry.route] : [])))].sort() });
  }
  return out;
}

/* The files of `report` whose every use is a test file of the app, per the code graph; an unread, cut or empty answer proves nothing. */
export function testSupportFiles(report: ImportersReport | undefined, skip: ReadonlySet<string> = new Set()): TestSupportFile[] {
  if (report === undefined) return [];
  const { dynamicLoaders } = report;
  if (!dynamicLoaders.complete || !dynamicLoaders.files.every((loader) => LanguageRegistry.isTestFile(loader))) return [];
  const onlyTests = (files: readonly string[]): boolean => files.every((f) => LanguageRegistry.isTestFile(f));
  return report.files
    .filter((f) => !skip.has(f.file) && f.indexed && f.complete && f.importers.length > 0 && onlyTests(f.importers) && onlyTests(f.users) && onlyTests(f.namedBy))
    .map((f) => ({ file: f.file, importers: f.importers.length }));
}

export function excludedFilesOf(exclusions: CoverageExclusions | undefined): Set<string> {
  return new Set([...(exclusions?.unreachableByDesign ?? []).map((e) => e.file), ...(exclusions?.testSupportFiles ?? []).map((e) => e.file)]);
}

/* The diff without the sections of `files`: what is measured, collected and mutated is the change that remains. */
export function diffWithoutFiles(diff: string, files: ReadonlySet<string>): string {
  if (files.size === 0) return diff;
  return diff
    .split(/^(?=diff --git )/m)
    .filter((section) => {
      const path = diffGitHeaderPath(section.split("\n", 1)[0]!);
      return path === undefined || !files.has(path);
    })
    .join("");
}
