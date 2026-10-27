/* BundleMutationPort for the e2e target: each mutant of the changed code is one re-run, against DEV, of the tests that reached it (the mutant names them to the seed's mutation fixture, which skips every other test of the spec files; a mutant that names none re-runs every test of its spec files), with the seed's mutation fixture editing that one script as the page loads it. A mutant is judged only when it reached a page (the fixture counts the responses it mutated beside the response oracle's counters) and the re-run ran tests that passed before: a mutant that reached no page, a re-run that could not run, and one that ran none of the passing tests say nothing of the tests. A judged mutant is killed when a test that passed before fails; its proof names the dumps of the spec files whose tests failed, so the changed code the mutant made run is credited to the tests that checked it. When asked to observe, each mutant's re-run also records the pages of its tests, and the survivors are compared with one unmutated re-run of their spec files: what the mutation moved in the requests and the accessible tree is recorded on each survivor (`moved`) for the regeneration that answers it, and holds nothing of the mutant. Signal-only: the result never gates publish. */
import type { BundleMutationPort } from "../application/ports/bundle-mutation.port.ts";
import type { BundleMutationResult, MutantProof, MutantRun } from "../domain/coverage-collector.ts";
import { diffObservations } from "../domain/observed-difference.ts";
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

/* What a survivor's re-run recorded: the pages of its tests (undefined when it left none) and the tests that passed in it. */
interface SurvivorPages {
  pages: ObservedPage[] | undefined;
  passed: ReadonlySet<string>;
}

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
        survivorPages.push({ pages: run.observations, passed: new Set(rerun.filter((c) => c.status === "pass").map((c) => c.name)) });
      }
    }
    if (opts.observe && survived.length > 0) await this.recordMoved(survived, survivorRuns, survivorPages, specDir, namespace);
    return applied > 0 ? { applied, killed, survived, ...(proofs.length > 0 ? { proofs } : {}), ...(survivorRuns.length > 0 ? { survivorRuns } : {}) } : null;
  }

  /*
   * What each survivor moved: one unmutated re-run of the survivors' spec files, observed like theirs, and each survivor's pages
   * compared with it over the tests that passed in both. A re-run that could not run, broke or left no observation leaves every
   * survivor unobserved; it never changes what was judged. The difference holds requests and tree lines of the pages, nothing of
   * the mutant.
   */
  private async recordMoved(survived: BundleMutationResult["survived"], runs: readonly MutantRun[], mutated: readonly SurvivorPages[], specDir: string, namespace: string): Promise<void> {
    const specFiles = [...new Set(runs.flatMap((r) => r.specFiles))].sort();
    let plain: SurvivorPages = { pages: undefined, passed: new Set() };
    try {
      const run = await this.runMutant({ dir: specDir, baseUrl: this.baseUrl, namespace: `${namespace}-obs`, specFiles, observe: true });
      if (run.verdict === "infra-error") engineLog.warn("[qa] mutation: the unmutated re-run the surviving mutants are compared with could not run; what they moved is not told");
      else plain = { pages: run.observations, passed: new Set(run.cases.filter((c) => c.status === "pass").map((c) => c.name)) };
    } catch (err) {
      engineLog.warn(`[qa] mutation: the unmutated re-run the surviving mutants are compared with failed (${err instanceof Error ? err.message : String(err)}); what they moved is not told`);
    }
    for (const [i, rerun] of mutated.entries()) {
      const comparable = new Set([...rerun.passed].filter((name) => plain.passed.has(name)));
      survived[i]!.moved = diffObservations(plain.pages, rerun.pages, comparable);
    }
  }
}
