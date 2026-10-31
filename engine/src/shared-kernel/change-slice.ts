/*
 * The part of the change one flow must exercise: every hunk that overlaps a seed or shared seed of the flow's candidates (a
 * whole-file seed takes every hunk of its file), each once with the candidate ids it serves, never cut. Everything else is a
 * reference: where it is, how large, its kind and why it is not owned. App test files, lockfiles, generated files and maps are
 * only ever references. Pure and deterministic: owned hunks ranked by class (code, other kinds, styles), then the optional
 * decision rank, then diff order; references in diff order.
 */
import { DiffParserService, type DiffHunk } from "./diff-parser/diff-parser.service.ts";
import { hunkLineCounts, hunkOverlapsSeed } from "./diff-hunks.ts";
import { fileKindOf, type ChangeMap, type ChangeMapFile, type FileKind } from "./change-map.ts";
import type { FileClass } from "./file-classes.ts";

const parser = new DiffParserService();

export type ReferenceWhy = "owned-by-other-flow" | "unassigned" | "test-file" | "generated" | "low-relevance";

export interface OwnedHunk {
  /* The hunk's position in the diff: its identity. */
  index: number;
  hunk: DiffHunk;
  kind: FileKind;
  /* The candidates of the slice this hunk serves, in the order the slice was asked for. */
  candidateIds: string[];
}

/* A hunk the slice does not own: enough to find it again (`path:start-end`) and to weigh it. */
export interface HunkReference {
  index: number;
  path: string;
  start: number;
  end: number;
  added: number;
  removed: number;
  kind: FileKind;
  why: ReferenceWhy;
}

export interface ChangeSlice {
  candidateIds: string[];
  owned: OwnedHunk[];
  references: HunkReference[];
}

export interface SliceOptions {
  /* Orders hunks of the same class, lower first (hunks holding a changed decision before the rest); default none. */
  decisionRank?: (hunk: DiffHunk) => number;
}

/* The hunks owned by no slice: the part of the diff no flow is responsible for. */
export interface UnassignedHunk {
  index: number;
  hunk: DiffHunk;
  kind: FileKind;
}

const CLASS_RANK: Record<FileClass, number> = { code: 0, other: 1, style: 2, generated: 3, "low-relevance": 4 };

/* Why a hunk can never be owned, or undefined when it can. */
function referenceOnly(file: ChangeMapFile | undefined): ReferenceWhy | undefined {
  if (file === undefined) return undefined;
  if (file.isTest) return "test-file";
  if (file.fileClass === "generated") return "generated";
  if (file.fileClass === "low-relevance") return "low-relevance";
  return undefined;
}

export function sliceFor(map: ChangeMap, diff: string, candidateIds: readonly string[], options: SliceOptions = {}): ChangeSlice {
  const files = new Map(map.files.map((file) => [file.path, file]));
  const asked = map.candidates.filter((candidate) => candidateIds.includes(candidate.id));
  const askedOrder = new Map(candidateIds.map((id, i) => [id, i]));
  asked.sort((a, b) => (askedOrder.get(a.id) ?? 0) - (askedOrder.get(b.id) ?? 0));
  const askedIds = new Set(asked.map((c) => c.id));
  const decisionRank = options.decisionRank ?? (() => 0);

  const owned: Array<OwnedHunk & { rank: [number, number, number] }> = [];
  const references: HunkReference[] = [];
  parser.hunks(diff).forEach((hunk, index) => {
    const file = files.get(hunk.file);
    const kind = file?.kind ?? fileKindOf(hunk.file);
    const only = referenceOnly(file);
    const serves = only ? [] : asked.filter((candidate) => candidate.seeds.some((seed) => hunkOverlapsSeed(hunk, seed))).map((c) => c.id);
    if (serves.length > 0) {
      owned.push({ index, hunk, kind, candidateIds: serves, rank: [CLASS_RANK[file?.fileClass ?? "other"], decisionRank(hunk), index] });
      return;
    }
    const why: ReferenceWhy = only ?? (map.candidates.some((c) => !askedIds.has(c.id) && c.seeds.some((seed) => hunkOverlapsSeed(hunk, seed))) ? "owned-by-other-flow" : "unassigned");
    const { added, removed } = hunkLineCounts(hunk);
    references.push({ index, path: hunk.file, start: hunk.newStart, end: hunk.newEnd, added, removed, kind, why });
  });
  owned.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  return {
    candidateIds: [...candidateIds],
    owned: owned.map(({ rank: _rank, ...rest }) => rest),
    references,
  };
}

/* The hunks no slice owns, in diff order, app test files, lockfiles and generated files left out (they are references wherever they are); the whole readable diff when there are no slices. */
export function unassignedOf(map: ChangeMap, diff: string, slices: readonly ChangeSlice[]): UnassignedHunk[] {
  const files = new Map(map.files.map((file) => [file.path, file]));
  const held = new Set(slices.flatMap((slice) => slice.owned.map((o) => o.index)));
  const rest: UnassignedHunk[] = [];
  parser.hunks(diff).forEach((hunk, index) => {
    const file = files.get(hunk.file);
    if (held.has(index) || referenceOnly(file) !== undefined) return;
    rest.push({ index, hunk, kind: file?.kind ?? fileKindOf(hunk.file) });
  });
  return rest;
}
