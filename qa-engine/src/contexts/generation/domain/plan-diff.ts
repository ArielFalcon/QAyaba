/*
 * The change as the lead plans from it: the change map (every changed file once, never cut) and the pieces of the diff in rank
 * order, each a hunk, or the whole file section when a file has no hunk to read (a deleted or binary file). App test files,
 * generated files and low-relevance files are only referenced. The rank is the slice's (change-slice.ts): code, other kinds,
 * styles, then the decision rank, then diff order. How many ranked pieces a prompt shows is the caller's, fitted to the lead's
 * window; every piece it does not show is named as a reference. Pure and deterministic.
 */
import { buildChangeMap, type ChangeMap, type ChangeMapFile, type FileKind } from "@kernel/change-map.ts";
import type { SliceOptions } from "@kernel/change-slice.ts";
import { hunkLineCounts, hunkOverlapsSeed, sectionPath, sectionStat } from "@kernel/diff-hunks.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { FILE_CLASS_ORDER } from "@kernel/file-classes.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

const parser = new DiffParserService();

/* Why a piece is named instead of shown: the kind of file it is in, or the lead's window. */
export type PlanReferenceWhy = "test-file" | "generated" | "low-relevance" | "window";

export interface PlanDiffPiece {
  /* The file it is in; the empty string for text before any file header. */
  path: string;
  kind: FileKind;
  /* The new-side lines a hunk spans; absent for a whole file section. */
  range?: { start: number; end: number };
  added: number;
  removed: number;
  /* The piece as diff text, without its file's `diff --git` line. */
  text: string;
  /* The candidates whose seeds the piece overlaps, in candidate order. */
  candidateIds: string[];
}

export interface PlanDiff {
  map: ChangeMap;
  /* The pieces a prompt may show, most relevant first. */
  ranked: PlanDiffPiece[];
  /* The pieces a prompt only ever names, in diff order, each with why. */
  referenceOnly: Array<PlanDiffPiece & { why: PlanReferenceWhy }>;
}

function referenceOnlyWhy(file: ChangeMapFile | undefined): PlanReferenceWhy | undefined {
  if (file === undefined) return undefined;
  if (file.isTest) return "test-file";
  if (file.fileClass === "generated") return "generated";
  if (file.fileClass === "low-relevance") return "low-relevance";
  return undefined;
}

/* The section's lines after its `diff --git` line: the whole file section as one piece. */
function sectionBody(section: string): string {
  const newline = section.indexOf("\n");
  return (newline < 0 ? "" : section.slice(newline + 1)).replace(/\n+$/, "");
}

export function planDiff(diff: string, candidates: readonly UseCaseCandidate[], options: SliceOptions = {}): PlanDiff {
  const map = buildChangeMap({ diff, candidates });
  const files = new Map(map.files.map((file) => [file.path, file]));
  const decisionRank = options.decisionRank ?? (() => 0);
  const ranked: Array<PlanDiffPiece & { rank: [number, number, number] }> = [];
  const referenceOnly: PlanDiff["referenceOnly"] = [];
  let order = 0;
  for (const section of diff.split(/^(?=diff --git )/m)) {
    if (section.trim() === "") continue;
    const path = sectionPath(section);
    const file = files.get(path);
    const kind: FileKind = file?.kind ?? "other";
    const classRank = FILE_CLASS_ORDER.indexOf(file?.fileClass ?? "other");
    const why = referenceOnlyWhy(file);
    const hunks = path === "" ? [] : parser.hunks(section);
    const pieces: Array<{ piece: PlanDiffPiece; decision: number }> =
      hunks.length > 0
        ? hunks.map((hunk) => ({
            piece: {
              path,
              kind,
              range: { start: hunk.newStart, end: hunk.newEnd },
              ...hunkLineCounts(hunk),
              text: [hunk.header, ...hunk.lines].join("\n"),
              candidateIds: map.candidates.filter((c) => c.seeds.some((seed) => hunkOverlapsSeed(hunk, seed))).map((c) => c.id),
            },
            decision: decisionRank(hunk),
          }))
        : [{ piece: { path, kind, added: sectionStat(section).added, removed: sectionStat(section).removed, text: path === "" ? section.replace(/\n+$/, "") : sectionBody(section), candidateIds: file?.seededBy ?? [] }, decision: 0 }];
    for (const { piece, decision } of pieces) {
      if (why !== undefined) referenceOnly.push({ ...piece, why });
      else ranked.push({ ...piece, rank: [classRank, decision, order] });
      order++;
    }
  }
  ranked.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  return { map, ranked: ranked.map(({ rank: _rank, ...piece }) => piece), referenceOnly };
}

/* Where a piece is: `path:start-end` for a hunk, the path alone for a whole file section. */
export function pieceLocation(piece: Pick<PlanDiffPiece, "path" | "range">): string {
  return piece.range ? `${piece.path}:${piece.range.start}-${piece.range.end}` : piece.path;
}
