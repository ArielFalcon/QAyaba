/* A candidate's coverage counts the added lines inside its seeds' ranges; a candidate with no measured line says why. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffChangedFiles, perCandidateCoverage, type PerCandidateInput } from "@contexts/objective-signal/domain/per-candidate-coverage.ts";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

const DIFF = [
  "diff --git a/web/a.ts b/web/a.ts",
  "--- a/web/a.ts",
  "+++ b/web/a.ts",
  "@@ -1,2 +1,8 @@",
  " keep",
  "+one",
  "+two",
  "+three",
  " keep2",
  "+four",
  "+five",
  "+six",
  "diff --git a/web/gone.ts b/web/gone.ts",
  "--- a/web/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
  "",
].join("\n");

function candidate(id: string, seeds: UseCaseCandidate["seeds"], over: Partial<UseCaseCandidate> = {}): UseCaseCandidate {
  return { id, entry: { kind: "page", repo: "web", route: `/${id}` }, tier: "direct", basis: "graph", evidence: [], seeds, confidence: 1, reachability: "page", pages: [], existingSpecs: [], ...over };
}

/* Lines 2-4 and 6-8 of web/a.ts are added. The run executed lines 2, 3 and 6. */
const COVERAGE = assembleChangeCoverage(DIFF, { covered: [{ file: "web/a.ts", lines: [2, 3, 6] }] });

const base = (candidates: UseCaseCandidate[], over: Partial<PerCandidateInput> = {}): PerCandidateInput => ({ candidates, diff: DIFF, coverage: COVERAGE, aggregate: undefined, crossRepo: false, ...over });

describe("perCandidateCoverage", () => {
  it("gives each candidate its own changed and covered counts over disjoint ranges", () => {
    const [first, second] = perCandidateCoverage(base([
      candidate("uc-1", [{ file: "web/a.ts", symbol: "a", range: { start: 1, end: 4 } }]),
      candidate("uc-2", [{ file: "web/a.ts", symbol: "b", range: { start: 5, end: 8 } }]),
    ]));
    assert.deepEqual([first!.changedLines, first!.coveredChanged, first!.ratio], [3, 2, 2 / 3]);
    assert.deepEqual([second!.changedLines, second!.coveredChanged, second!.ratio], [3, 1, 1 / 3]);
  });

  it("counts a line once when ranges of one candidate overlap", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "a", range: { start: 1, end: 5 } }, { file: "web/a.ts", symbol: "b", range: { start: 3, end: 8 } }])]));
    assert.equal(only!.changedLines, 6);
  });

  it("counts every added line of a seed that has no range", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "a" }])]));
    assert.equal(only!.changedLines, 6);
  });

  it("marks a backend-only candidate as backend, with no ratio, whatever else is true", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "a" }], { reachability: "backend-only", tier: "cross-repo" })]));
    assert.deepEqual([only!.unmeasured, only!.ratio], ["backend", null]);
  });

  it("marks a candidate reached from another repo, and every candidate when the diff was withheld, as cross-repo", () => {
    const [byTier] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "a" }], { tier: "cross-repo" })]));
    assert.equal(byTier!.unmeasured, "cross-repo");
    const [withheld] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "a" }])], { diff: undefined, coverage: null, aggregate: "no-diff", crossRepo: true }));
    assert.equal(withheld!.unmeasured, "cross-repo");
  });

  it("marks a candidate whose seed file only lost lines as deletion-only", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/gone.ts", symbol: "g" }])]));
    assert.deepEqual([only!.unmeasured, only!.ratio, only!.changedLines], ["deletion-only", null, 0]);
  });

  it("carries the aggregate's reason when the aggregate decided nothing, such as no source maps", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "a" }])], { coverage: assembleChangeCoverage(DIFF, { covered: [] }), aggregate: "no-source-maps" }));
    assert.deepEqual([only!.unmeasured, only!.ratio, only!.changedLines], ["no-source-maps", null, 6]);
  });

  it("says no-changed-lines for a measured candidate whose seeds hold no added line", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "a", range: { start: 100, end: 120 } }])]));
    assert.deepEqual([only!.unmeasured, only!.ratio], ["no-changed-lines", null]);
  });
});

describe("diffChangedFiles", () => {
  it("names added, modified and deleted files once", () => {
    assert.deepEqual(diffChangedFiles(DIFF).sort(), ["web/a.ts", "web/gone.ts"]);
  });
});

describe("perCandidateCoverage of a candidate seeded by a whole file", () => {
  it("measures every added line of the file, as the aggregate does", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/a.ts", symbol: "*" }])]));
    assert.deepEqual([only!.changedLines, only!.coveredChanged, only!.ratio, only!.unmeasured], [6, 3, 0.5, undefined]);
  });

  it("is deletion-only when the file it names was only deleted", () => {
    const [only] = perCandidateCoverage(base([candidate("uc-1", [{ file: "web/gone.ts", symbol: "*" }])]));
    assert.deepEqual([only!.changedLines, only!.ratio, only!.unmeasured], [0, null, "deletion-only"]);
  });
});
