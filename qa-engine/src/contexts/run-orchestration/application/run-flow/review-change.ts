/*
 * The change as the reviewer of a planned run receives it: the slice of each flow under review, the full changed-file list, and
 * everything no flow under review holds (in full, or named when it is only ever referenced). A hunk a flow not under review would own
 * is part of what no flow under review holds, so the reviewer never sees less than the change. With no plan, no flow under review,
 * or nothing such a flow owns, there is no view and the reviewer keeps the whole diff. Pure.
 */
import { buildChangeMap } from "@kernel/change-map.ts";
import { sliceFor, unassignedOf } from "@kernel/change-slice.ts";
import { decisionRankOf, type ChangedDecision } from "@kernel/changed-decision.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { sectionPath } from "@kernel/diff-hunks.ts";
import { resolveSpecReference } from "@kernel/spec-path.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ReviewChangeView } from "@contexts/generation/application/index.ts";

const parser = new DiffParserService();

export interface ReviewChangeInput {
  diff: string;
  candidates: readonly UseCaseCandidate[];
  /* The plan's flows, by spec file, with the use cases each cites; empty when the run had no plan. */
  flows: ReadonlyArray<{ specFile: string; candidates: readonly string[] }>;
  specsUnderReview: readonly string[];
  specRelDir: string;
  /* The decisions on the diff's changed lines (static listing of the run's working copy): a flow's hunks holding one rank first. */
  decisions?: readonly ChangedDecision[];
}

export function reviewChangeViewOf(input: ReviewChangeInput): ReviewChangeView | undefined {
  const { diff, candidates, flows, specRelDir } = input;
  if (flows.length === 0 || candidates.length === 0 || diff.trim() === "") return undefined;
  const reviewed = new Set(input.specsUnderReview.map((spec) => resolveSpecReference(spec, specRelDir) ?? spec));
  const underReview = flows.filter((flow) => reviewed.has(resolveSpecReference(flow.specFile, specRelDir) ?? flow.specFile));
  if (underReview.length === 0) return undefined;

  const map = buildChangeMap({ diff, candidates });
  const decisions = input.decisions ?? [];
  const decisionRank = decisionRankOf(decisions);
  const slices = underReview.map((flow) => ({ specFile: flow.specFile, slice: sliceFor(map, diff, flow.candidates, { decisionRank }) }));
  if (slices.every(({ slice }) => slice.owned.length === 0)) return undefined;

  const onlyReferenced = new Set(map.files.filter((file) => file.isTest || file.fileClass === "generated" || file.fileClass === "low-relevance").map((file) => file.path));
  const withHunks = new Set(parser.hunks(diff).map((hunk) => hunk.file));
  const hunkless = diff
    .split(/^(?=diff --git )/m)
    .map((section) => ({ path: sectionPath(section), section }))
    .filter(({ path }) => path !== "" && !withHunks.has(path) && !onlyReferenced.has(path));

  return {
    files: map.files,
    flows: slices.map(({ specFile, slice }) => ({ specFile, candidateIds: slice.candidateIds, owned: slice.owned })),
    unassigned: unassignedOf(map, diff, slices.map(({ slice }) => slice)),
    hunkless,
    /* Every slice references each hunk it does not own; the ones only ever referenced are the same in all of them. */
    referenced: slices[0]!.slice.references.filter((ref) => ref.why === "test-file" || ref.why === "generated" || ref.why === "low-relevance"),
    ...(decisions.length > 0 ? { decisions } : {}),
  };
}
