/*
 * Change-coverage per use case the change makes testable: of the added lines inside a candidate's seeds, how many the green run
 * executed, or why the candidate has no ratio. A signal beside the aggregate, which stays the only figure that decides anything.
 * Pure.
 */
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ChangeCoverage } from "./decide-coverage.service.ts";
import { parseDiffHunks } from "./assemble-change-coverage.ts";
/* Why the aggregate measurement decides nothing. */
export type AggregateUnmeasured = "no-diff" | "not-assembled" | "no-changed-lines" | "deletion-only" | "no-changed-file-mapped" | "no-source-maps";

/* Why a candidate has no ratio: the aggregate's own reasons, and the two that only a candidate can have. */
export type CandidateUnmeasured = AggregateUnmeasured | "backend" | "cross-repo";

export interface CandidateCoverage {
  candidateId: string;
  changedLines: number;
  coveredChanged: number;
  /* Absent of a ratio when the candidate has no measured line. */
  ratio: number | null;
  unmeasured?: CandidateUnmeasured;
}

export interface PerCandidateInput {
  candidates: readonly UseCaseCandidate[];
  /* Absent when the diff was withheld. */
  diff: string | undefined;
  /* Null when no coverage was assembled. */
  coverage: ChangeCoverage | null;
  /* The aggregate's reason when it decided nothing; absent when it measured. */
  aggregate: AggregateUnmeasured | undefined;
  /* The diff was withheld because the changed lines live in another repo than the one the browser serves. */
  crossRepo: boolean;
}

/* The files a diff changes, whatever it does to them: a deleted file is named by its `diff --git` header. */
export function diffChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const raw of diff.split("\n")) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (git) files.add(git[2]!);
    else if (raw.startsWith("+++ ") && !raw.startsWith("+++ /dev/null")) files.add(raw.slice(4).trim().replace(/^[ab]\//, "").replace(/\t.*/, ""));
  }
  return [...files];
}

function candidateLines(candidate: UseCaseCandidate, added: ReadonlyMap<string, ReadonlySet<number>>): Set<string> {
  const lines = new Set<string>();
  for (const seed of candidate.seeds) {
    for (const line of added.get(seed.file) ?? []) {
      if (seed.range === undefined || (line >= seed.range.start && line <= seed.range.end)) lines.add(`${seed.file}\u0000${line}`);
    }
  }
  return lines;
}

export function perCandidateCoverage(input: PerCandidateInput): CandidateCoverage[] {
  const added = input.diff !== undefined ? parseDiffHunks(input.diff) : new Map<string, Set<number>>();
  const touched = new Set(input.diff !== undefined ? diffChangedFiles(input.diff) : []);
  const uncovered = new Map((input.coverage?.uncovered ?? []).map((u) => [u.file, new Set(u.lines)]));
  return input.candidates.map((candidate) => {
    const lines = candidateLines(candidate, added);
    const changedLines = lines.size;
    const covered = input.coverage?.measured ? [...lines].filter((key) => { const [file, line] = key.split("\u0000"); return !uncovered.get(file!)?.has(Number(line)); }).length : 0;
    const result = (unmeasured: CandidateUnmeasured): CandidateCoverage => ({ candidateId: candidate.id, changedLines, coveredChanged: 0, ratio: null, unmeasured });
    if (candidate.reachability === "backend-only") return result("backend");
    if (input.crossRepo || candidate.tier === "cross-repo") return result("cross-repo");
    if (changedLines === 0 && candidate.seeds.some((seed) => touched.has(seed.file)) && !candidate.seeds.some((seed) => added.has(seed.file))) return result("deletion-only");
    if (input.aggregate !== undefined && input.aggregate !== "no-changed-lines") return result(input.aggregate);
    if (changedLines === 0 || !input.coverage?.measured) return result(input.aggregate ?? "no-changed-lines");
    return { candidateId: candidate.id, changedLines, coveredChanged: covered, ratio: covered / changedLines };
  });
}
