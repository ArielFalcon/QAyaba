/* Which mutants of the served script a run re-runs, and which tests each one re-runs. Pure; no I/O.
   A mutant is made only where the change is (a site on a changed line) and only where a test reached (a site that ran). First come the decisions of the changed lines an arm of which no test ran, each by the site that forces it (the negated condition of an if or a `?:`, the swapped operator of a `&&` or `||`): the code no test ran is what a killed mutant can prove the tests check. The rest are one per changed line, taken across the changed files in turn, so a few mutants speak of as much of the change as they can. Each re-runs the spec files whose tests ran its site: a dump is named after its test's title path, which starts with the spec file's path, and when no spec file can be told from the names every spec file that passed is re-run. */
import type { BranchHit, MutationSite } from "./coverage-collector.ts";
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

/* The site that forces the arms of a decision no test ran: at the decision's own place, the negation of an if's or a conditional's condition, the swap of a logical operator other than `??`. */
function forces(site: MutationSite, decision: BranchHit): boolean {
  if (site.file !== decision.file || site.line !== decision.line || site.column !== decision.column) return false;
  if (decision.kind === "if" || decision.kind === "conditional") return site.operator === "negate condition";
  return decision.kind === "logical" && /^(&&|\|\|) →/.test(site.operator);
}

/* Up to `max` mutants on the changed lines: first the one that forces each decision with an arm no test ran, then one per line (its first site), taken across the changed files in turn. */
export function selectMutants(sites: readonly MutationSite[], changed: ReadonlyMap<string, ReadonlySet<number>>, caseFiles: readonly string[], max = MAX_MUTANTS, decisions: readonly BranchHit[] = []): SelectedMutant[] {
  const usable = sites.filter((site) => site.ranIn.length > 0 && changed.get(site.file)?.has(site.line));
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
  return picked.map((site) => ({ site, specFiles: specFilesOf(site.ranIn, caseFiles) }));
}
