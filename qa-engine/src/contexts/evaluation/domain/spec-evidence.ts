/*
 * Which of a run's delivered specs passed: the attribution of the final execution's cases to the specs, the count of specs that
 * passed, and each delivered spec's newest bytes. Shared by the evidence a grader reads, the run record and the run view, so all of them
 * report one count.
 */
import { RUN_PHASES } from "@kernel/run-step.ts";
import { sameSpecPathByTail } from "@kernel/spec-path.ts";
import type { DeliveredSpecEvidence } from "./run-evaluation-evidence.ts";
import type { EvidenceRunRecord, EvidenceSpecSnapshot } from "./evidence-sources.ts";

const rank = (phase: string): number => (RUN_PHASES as readonly string[]).indexOf(phase);

/* The verdicts of a run whose specs ran in the final execution. */
const EXECUTED_VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "flaky"]);

export const ranInFinalExecution = (record: Pick<EvidenceRunRecord, "verdict">): boolean => record.verdict !== undefined && EXECUTED_VERDICTS.has(record.verdict);

/*
 * A case belongs to a spec when the file the report named for it is the spec's path, or the path's tail on a directory boundary
 * (the report names the file relative to the test directory, the spec list relative to the repository). A file that fits more
 * than one spec fits none: an ambiguous attribution is not one.
 */
export function specOfCase(file: string | undefined, specNames: readonly string[]): string | undefined {
  if (!file) return undefined;
  const fits = specNames.filter((s) => sameSpecPathByTail(s, file));
  return fits.length === 1 ? fits[0] : undefined;
}

/*
 * How many delivered specs passed, or undefined when that cannot be told. Cases are tied to specs by file (specOfCase). When every
 * spec has at least one case, a spec passed when all of its cases did. When any spec has none, the cases cannot be tied to the
 * suite: only a run-level pass, which means every case passed, still answers.
 */
export function countPassedSpecs(specNames: readonly string[], cases: ReadonlyArray<{ name: string; status: string; file?: string | undefined }>, valid: number, verdict: string | null): number | undefined {
  if (valid === 0) return 0;
  const bySpec = new Map<string, string[]>();
  for (const c of cases) {
    const spec = specOfCase(c.file, specNames);
    if (spec) bySpec.set(spec, [...(bySpec.get(spec) ?? []), c.status]);
  }
  if (specNames.length > 0 && specNames.every((s) => bySpec.has(s))) {
    return specNames.filter((s) => bySpec.get(s)!.every((st) => st === "pass")).length;
  }
  return verdict === "pass" ? valid : undefined;
}

export interface SpecCounts {
  generated: number;
  valid: number | null;
  passed: number | undefined;
}

/*
 * The specs a run delivered: the record's own list when it holds one, else the delivered snapshots. The validate phase keeps a
 * snapshot of every delivered spec whatever path the run takes afterwards (the run record's list is written only by the normal
 * exit), so a run that fails after validation still says what it produced. The record's list wins whole: a run that recorded it
 * never counts a snapshot on top.
 */
export function deliveredSpecNames(record: Pick<EvidenceRunRecord, "specs">, snapshots: ReadonlyArray<Pick<EvidenceSpecSnapshot, "path" | "delivered">>): string[] {
  const named = (record.specs ?? []).map((s) => s.name);
  if (named.length > 0) return named;
  return [...new Set(snapshots.filter((s) => s.delivered === 1).map((s) => s.path))].sort();
}

/* The counts the run record, the run view, the graders and the run's own trace all report. Validation gates the whole suite: it is a measurement only once the run got past it. */
export function specCountsOf(record: Pick<EvidenceRunRecord, "specs" | "cases" | "verdict">, snapshots: ReadonlyArray<Pick<EvidenceSpecSnapshot, "path" | "delivered">>, furthestPhase: string | null): SpecCounts {
  const specNames = deliveredSpecNames(record, snapshots);
  const generated = specNames.length;
  const valid = record.verdict === "invalid" ? 0 : furthestPhase !== null && rank(furthestPhase) > rank("validate") ? generated : null;
  return { generated, valid, passed: valid === null ? undefined : countPassedSpecs(specNames, record.cases, valid, record.verdict ?? null) };
}

/* Each delivered spec's newest delivered bytes and whether every case tied to it passed the final execution. */
export function deliveredSpecsOf(specNames: readonly string[], snapshots: readonly EvidenceSpecSnapshot[], record: Pick<EvidenceRunRecord, "cases" | "verdict">): DeliveredSpecEvidence[] {
  const executed = ranInFinalExecution(record);
  return specNames.map((path) => {
    const newest = snapshots.filter((s) => s.delivered === 1 && specOfCase(s.path, [path]) !== undefined).sort((a, b) => b.capturedAt - a.capturedAt)[0];
    const statuses = record.cases.filter((c) => specOfCase(c.file, specNames) === path).map((c) => c.status);
    return { path, sha256: newest?.sha256, passed: !executed || statuses.length === 0 ? undefined : statuses.every((st) => st === "pass") };
  });
}
