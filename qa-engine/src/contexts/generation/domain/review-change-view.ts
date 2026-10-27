/*
 * The change as the reviewer of a planned run receives it, instead of the whole commit diff: the slice of each flow under review,
 * the full changed-file list, and everything no flow under review holds. Together they never show less than the change: what no
 * slice holds is given in full, and what is only ever referenced (app test files, generated and low-relevance files) is named.
 */
import type { ChangeMapFile } from "@kernel/change-map.ts";
import type { HunkReference, OwnedHunk, UnassignedHunk } from "@kernel/change-slice.ts";

/* One flow under review: its spec, the use cases it cites, and the hunks its slice owns, ranked. */
export interface ReviewFlowSlice {
  specFile: string;
  candidateIds: string[];
  owned: OwnedHunk[];
}

/* A changed file whose diff section has no hunk (a deletion, a binary or a rename): its whole section. */
export interface HunklessSection {
  path: string;
  section: string;
}

export interface ReviewChangeView {
  /* Every changed file once, never cut. */
  files: ChangeMapFile[];
  flows: ReviewFlowSlice[];
  /* The hunks no slice of a flow under review holds, in diff order: given in full. */
  unassigned: UnassignedHunk[];
  /* The sections with no hunk that are not only ever referenced: given in full beside the unassigned hunks. */
  hunkless: HunklessSection[];
  /* The hunks that are only ever referenced (app test files, generated and low-relevance files), in diff order. */
  referenced: HunkReference[];
}
