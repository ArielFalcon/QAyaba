/* Which mutants of the served script a run re-runs, and which tests each one re-runs. Pure; no I/O.
   A mutant is made only where the change is (a site on a changed line) and only where a test reached (a site that ran), one per changed line, taken across the changed files in turn, so a few mutants speak of as much of the change as they can. Each re-runs the spec files whose tests ran its site: a dump is named after its test's title path, which starts with the spec file's path, and when no spec file can be told from the names every spec file that passed is re-run. */
import type { MutationSite } from "./coverage-collector.ts";
import { isDumpOfSpecFile } from "./dump-names.ts";

/* How many mutants a run re-runs: each costs a re-run of the tests that reach it against DEV. */
export const MAX_MUTANTS = 3;

export interface SelectedMutant {
  site: MutationSite;
  specFiles: string[];
}

/* The spec files among `caseFiles` whose tests wrote the dumps `ranIn` names; every case file when none can be told. */
export function specFilesOf(ranIn: readonly string[], caseFiles: readonly string[]): string[] {
  const files = [...new Set(caseFiles)].sort();
  const matched = files.filter((file) => ranIn.some((dump) => isDumpOfSpecFile(dump, file)));
  return matched.length > 0 ? matched : files;
}

/* Up to `max` mutants on the changed lines, one per line (its first site), taken across the changed files in turn. */
export function selectMutants(sites: readonly MutationSite[], changed: ReadonlyMap<string, ReadonlySet<number>>, caseFiles: readonly string[], max = MAX_MUTANTS): SelectedMutant[] {
  const byFile = new Map<string, MutationSite[]>();
  const seenLines = new Set<string>();
  for (const site of sites) {
    if (site.ranIn.length === 0 || !changed.get(site.file)?.has(site.line)) continue;
    const line = `${site.file}:${site.line}`;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const list = byFile.get(site.file) ?? [];
    list.push(site);
    byFile.set(site.file, list);
  }
  const queues = [...byFile.keys()].sort().map((file) => byFile.get(file)!);
  const picked: MutationSite[] = [];
  for (let round = 0; picked.length < max && queues.some((q) => q.length > round); round++) {
    for (const queue of queues) {
      if (picked.length >= max) break;
      const site = queue[round];
      if (site) picked.push(site);
    }
  }
  return picked.map((site) => ({ site, specFiles: specFilesOf(site.ranIn, caseFiles) }));
}
