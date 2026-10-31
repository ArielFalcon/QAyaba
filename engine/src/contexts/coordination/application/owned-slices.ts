/*
 * How much of the change a flow would own, read from the change map and the owned slice of its candidates (`sliceFor`): the hunks
 * and the lines they add and remove, and the bytes of those hunks, which is what an author's brief preloads. The planning turn is
 * told each candidate's size so the lead groups candidates into flows of a workable size; an admitted flow whose owned bytes alone do
 * not fit an author's window is asked of the lead to split. Pure: no clock, no file, no model.
 */
import { buildChangeMap, type ChangeMap } from "@kernel/change-map.ts";
import { sliceFor } from "@kernel/change-slice.ts";
import { hunkLineCounts } from "@kernel/diff-hunks.ts";
import type { OwnedSliceSize, UseCaseCandidate } from "@kernel/use-case-candidate.ts";

/* The run's change as the slices are cut from it: the map and the diff it was built from. */
export interface ChangeView {
  map: ChangeMap;
  diff: string;
}

/* The change of the run's diffs (one per repository), or undefined when there is no diff or no candidate to own a part of it. */
export function changeViewOf(diffs: readonly string[] | undefined, candidates: readonly UseCaseCandidate[] | undefined): ChangeView | undefined {
  const diff = (diffs ?? []).filter((d) => d.trim() !== "").join("\n");
  if (diff === "" || (candidates ?? []).length === 0) return undefined;
  return { map: buildChangeMap({ diff, candidates: candidates ?? [] }), diff };
}

/* The owned slice of these candidates, as its size and its bytes. */
export function ownedSliceOf(view: ChangeView, candidateIds: readonly string[]): OwnedSliceSize & { bytes: number } {
  const slice = sliceFor(view.map, view.diff, candidateIds);
  let added = 0;
  let removed = 0;
  let bytes = 0;
  for (const owned of slice.owned) {
    const counts = hunkLineCounts(owned.hunk);
    added += counts.added;
    removed += counts.removed;
    bytes += Buffer.byteLength(owned.hunk.lines.join("\n"), "utf8");
  }
  return { hunks: slice.owned.length, added, removed, bytes };
}

/* Each candidate's owned slice on its own, by id. */
export function candidateSlicesOf(view: ChangeView, candidates: readonly UseCaseCandidate[]): Record<string, OwnedSliceSize> {
  return Object.fromEntries(
    candidates.map((candidate) => {
      const { hunks, added, removed } = ownedSliceOf(view, [candidate.id]);
      return [candidate.id, { hunks, added, removed }];
    }),
  );
}
