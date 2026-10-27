/* BundleMutationPort for the e2e target: each mutant of the changed code is one re-run, against DEV, of the spec files whose tests reached it, with the seed's mutation fixture editing that one script as the page loads it. A mutant is judged only when it reached a page (the fixture counts the responses it mutated beside the response oracle's counters) and the re-run ran tests that passed before: a mutant that reached no page, a re-run that could not run, and one that ran none of the passing tests say nothing of the tests. A judged mutant is killed when a test that passed before fails; its proof names the dumps of the spec files whose tests failed, so the changed code the mutant made run is credited to the tests that checked it. Signal-only: the result never gates publish. */
import type { BundleMutationPort } from "../application/ports/bundle-mutation.port.ts";
import type { BundleMutationResult, MutantProof, MutantRun } from "../domain/coverage-collector.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";

type RunMutant = (args: { dir: string; baseUrl: string; namespace: string; mutant: string; specFiles: string[] }) => Promise<{ verdict: string; cases: QaCase[] }>;
/* How many responses the re-run of `namespace` mutated; undefined when that cannot be told. */
type CountMutated = (e2eDir: string, namespace: string) => number | undefined;

/* The longest text of an edit a finding or a record carries. */
const MAX_EDIT_TEXT_CHARS = 120;
/* Source text on one line and cut: it is shown to an author and persisted, never inlined whole. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EDIT_TEXT_CHARS ? `${flat.slice(0, MAX_EDIT_TEXT_CHARS)}…` : flat;
};

export class BundleMutationOracleAdapter implements BundleMutationPort {
  constructor(
    private readonly runMutant: RunMutant,
    private readonly countMutated: CountMutated,
    private readonly baseUrl: string,
  ) {}

  async measure(mutants: MutantRun[], specDir: string, namespace: string, baselineCases: string[]): Promise<BundleMutationResult | null> {
    if (!this.baseUrl || mutants.length === 0 || baselineCases.length === 0) return null;
    const passedBefore = new Set(baselineCases);
    let applied = 0;
    let killed = 0;
    const survived: BundleMutationResult["survived"] = [];
    const proofs: MutantProof[] = [];
    for (const [i, { site, specFiles }] of mutants.entries()) {
      const mutantNamespace = `${namespace}-mut${i}`;
      const mutant = JSON.stringify({ url: site.script.url, sha256: site.script.sha256, ...site.edit });
      const run = await this.runMutant({ dir: specDir, baseUrl: this.baseUrl, namespace: mutantNamespace, mutant, specFiles });
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
      } else survived.push({ file: site.file, line: site.line, operator: site.operator, specFiles, original: oneLine(site.original), replacement: oneLine(site.edit.replacement) });
    }
    return applied > 0 ? { applied, killed, survived, ...(proofs.length > 0 ? { proofs } : {}) } : null;
  }
}
