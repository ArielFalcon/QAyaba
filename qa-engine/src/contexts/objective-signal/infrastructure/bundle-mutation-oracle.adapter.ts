/* BundleMutationPort for the e2e target: each mutant of the changed code is one re-run, against DEV, of the tests that reached it (the mutant names them to the seed's mutation fixture, which skips every other test of the spec files; a mutant that names none re-runs every test of its spec files), with the seed's mutation fixture editing that one script as the page loads it. A mutant is judged only when it reached a page (the fixture counts the responses it mutated beside the response oracle's counters) and the re-run ran tests that passed before: a mutant that reached no page, a re-run that could not run, and one that ran none of the passing tests say nothing of the tests. A judged mutant is killed when a test that passed before fails; its proof names the dumps of the spec files whose tests failed, so the changed code the mutant made run is credited to the tests that checked it. When asked to observe, each mutant's re-run also records the pages of its tests, and the survivors are compared with two unmutated re-runs of their spec files, whose own differences are run-to-run noise: what the mutation moved in the requests and the accessible tree is recorded on each survivor, over all its tests (`moved`) and per spec file (`movedBySpec`), for the regeneration that answers it, and holds nothing of the mutant. Signal-only: the result never gates publish. */
import type { BundleMutationPort } from "../application/ports/bundle-mutation.port.ts";
import type { BundleMutationResult, MutantProof, MutantRun } from "../domain/coverage-collector.ts";
import { diffObservations, movedBySpecFile } from "../domain/observed-difference.ts";
import type { ObservedPage } from "../domain/observed-page.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";

/* A re-run of `specFiles`: with `mutant` applied, or none (the unmutated re-run a survivor is compared with); `observe` has the fixtures record the pages of its tests. */
type RunMutant = (args: { dir: string; baseUrl: string; namespace: string; mutant?: string; specFiles: string[]; observe?: boolean }) => Promise<{ verdict: string; cases: QaCase[]; observations?: ObservedPage[] }>;
/* How many responses the re-run of `namespace` mutated; undefined when that cannot be told. */
type CountMutated = (e2eDir: string, namespace: string) => number | undefined;

/* The longest text of an edit a finding or a record carries. */
const MAX_EDIT_TEXT_CHARS = 120;
/* Source text on one line and cut: it is shown to an author and persisted, never inlined whole. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EDIT_TEXT_CHARS ? `${flat.slice(0, MAX_EDIT_TEXT_CHARS)}…` : flat;
};

/* What a re-run recorded: the pages of its tests (undefined when it left none), the tests that passed in it, and the spec file of each test it ran. */
interface SurvivorPages {
  pages: ObservedPage[] | undefined;
  passed: ReadonlySet<string>;
  files: ReadonlyMap<string, string>;
}

const pagesOf = (run: { cases: readonly QaCase[]; observations?: ObservedPage[] }, passed: readonly QaCase[]): SurvivorPages => ({
  pages: run.observations,
  passed: new Set(passed.filter((c) => c.status === "pass").map((c) => c.name)),
  files: new Map(run.cases.flatMap((c) => (c.file ? [[c.name, c.file] as const] : []))),
});

const UNOBSERVED: SurvivorPages = { pages: undefined, passed: new Set(), files: new Map() };

export class BundleMutationOracleAdapter implements BundleMutationPort {
  constructor(
    private readonly runMutant: RunMutant,
    private readonly countMutated: CountMutated,
    private readonly baseUrl: string,
  ) {}

  async measure(mutants: MutantRun[], specDir: string, namespace: string, baselineCases: string[], opts: { observe?: boolean } = {}): Promise<BundleMutationResult | null> {
    if (!this.baseUrl || mutants.length === 0 || baselineCases.length === 0) return null;
    const passedBefore = new Set(baselineCases);
    let applied = 0;
    let killed = 0;
    const survived: BundleMutationResult["survived"] = [];
    const proofs: MutantProof[] = [];
    const survivorRuns: MutantRun[] = [];
    const survivorPages: SurvivorPages[] = [];
    for (const [i, { site, specFiles, tests }] of mutants.entries()) {
      const mutantNamespace = `${namespace}-mut${i}`;
      const mutant = JSON.stringify({ url: site.script.url, sha256: site.script.sha256, ...site.edit, ...(tests ? { tests } : {}) });
      const run = await this.runMutant({ dir: specDir, baseUrl: this.baseUrl, namespace: mutantNamespace, mutant, specFiles, ...(opts.observe ? { observe: true } : {}) });
      if (run.verdict === "infra-error") {
        engineLog.warn(`[qa] mutation: the re-run of the mutant at ${site.file}:${site.line} (${site.operator}) could not run; it is not judged`);
        continue;
      }
      if (!this.countMutated(specDir, mutantNamespace)) {
        engineLog.warn(`[qa] mutation: the mutant at ${site.file}:${site.line} (${site.operator}) reached no page (its script was not served as the coverage saw it, or the suite has no mutation fixture); it is not judged`);
        continue;
      }
      const rerun = run.cases.filter((c) => passedBefore.has(c.name));
      if (rerun.length === 0) continue;
      applied++;
      const noticed = rerun.filter((c) => c.status === "fail" || c.status === "flaky");
      if (noticed.length > 0) {
        killed++;
        const failedFiles = [...new Set(noticed.flatMap((c) => (c.file ? [c.file] : [])))];
        proofs.push({ namespace: mutantNamespace, specFiles: failedFiles.length > 0 ? failedFiles : specFiles, url: site.script.url, sha256: site.script.sha256, edit: site.edit, original: site.original });
      } else {
        survived.push({ file: site.file, line: site.line, operator: site.operator, specFiles, original: oneLine(site.original), replacement: oneLine(site.edit.replacement) });
        survivorRuns.push({ site, specFiles, ...(tests ? { tests } : {}) });
        survivorPages.push(pagesOf(run, rerun));
      }
    }
    if (opts.observe && survived.length > 0) await this.recordMoved(survived, survivorRuns, survivorPages, specDir, namespace);
    return applied > 0 ? { applied, killed, survived, ...(proofs.length > 0 ? { proofs } : {}), ...(survivorRuns.length > 0 ? { survivorRuns } : {}) } : null;
  }

  /*
   * What each survivor moved: two unmutated re-runs of the survivors' spec files, observed like theirs, and each survivor's pages
   * compared with them over the tests that passed in all three. What the two unmutated re-runs disagree on is run-to-run noise and is
   * never told; without both there is no noise floor, so every survivor is unobserved. Each survivor is told what moved over all its
   * tests and per spec file, so its finding reaches only the files whose own pages moved. A re-run that could not run, broke or left no
   * observation never changes what was judged. The difference holds requests and tree lines of the pages, nothing of the mutant.
   */
  private async recordMoved(survived: BundleMutationResult["survived"], runs: readonly MutantRun[], mutated: readonly SurvivorPages[], specDir: string, namespace: string): Promise<void> {
    const specFiles = [...new Set(runs.flatMap((r) => r.specFiles))].sort();
    const first = await this.unmutated(specDir, `${namespace}-obs`, specFiles);
    const second = first.pages === undefined ? UNOBSERVED : await this.unmutated(specDir, `${namespace}-obs2`, specFiles);
    const baseline = [first.pages, second.pages] as const;
    for (const [i, rerun] of mutated.entries()) {
      const comparable = new Set([...rerun.passed].filter((name) => first.passed.has(name) && second.passed.has(name)));
      const fileOf = (name: string): string | undefined => rerun.files.get(name) ?? first.files.get(name) ?? second.files.get(name);
      survived[i]!.moved = diffObservations(baseline, rerun.pages, comparable);
      /* Per file only when every compared test is placed in one: a test no file is known for would vanish from every file's account. */
      if ([...comparable].every((name) => fileOf(name) !== undefined)) survived[i]!.movedBySpec = movedBySpecFile(baseline, rerun.pages, comparable, fileOf, runs[i]!.specFiles);
    }
  }

  /* One unmutated, observed re-run of `specFiles`; unobserved when it could not run or broke. */
  private async unmutated(specDir: string, namespace: string, specFiles: string[]): Promise<SurvivorPages> {
    try {
      const run = await this.runMutant({ dir: specDir, baseUrl: this.baseUrl, namespace, specFiles, observe: true });
      if (run.verdict !== "infra-error") return pagesOf(run, run.cases);
      engineLog.warn(`[qa] mutation: the unmutated re-run ${namespace} the surviving mutants are compared with could not run; what they moved is not told`);
    } catch (err) {
      engineLog.warn(`[qa] mutation: the unmutated re-run ${namespace} the surviving mutants are compared with failed (${err instanceof Error ? err.message : String(err)}); what they moved is not told`);
    }
    return UNOBSERVED;
  }
}
