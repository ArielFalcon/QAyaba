/*
 * The change as the lead plans from it: the change map (every changed file once, never cut) and the pieces of the diff in rank
 * order, each a hunk, or the whole file section when a file has no hunk to read (a deleted or binary file). A piece is shown only
 * when a use-case candidate stands on it: an app test file, generated or low-relevance file is only referenced, so is a change of
 * whitespace alone and every piece no candidate's seeds are in. A diff no candidate backs, or a run with no candidates, keeps the
 * earlier treatment, so a plan turn is never left without a diff. Every piece is shown once or named once. The rank is the slice's
 * (change-slice.ts): code, other kinds, styles, then the decision rank, then diff order. How many ranked pieces a prompt shows is
 * the caller's, fitted to the lead's window; every piece it does not show is named as a reference. Pure and deterministic.
 */
import { buildChangeMap, type ChangeMap, type ChangeMapFile, type FileKind } from "@kernel/change-map.ts";
import type { SliceOptions } from "@kernel/change-slice.ts";
import { hunkLineCounts, hunkOverlapsSeed, sectionPath, sectionStat } from "@kernel/diff-hunks.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { FILE_CLASS_ORDER } from "@kernel/file-classes.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

const parser = new DiffParserService();

/* Why a piece is named instead of shown: the kind of file it is in, a change of whitespace alone, no use-case candidate standing on it, or the lead's window. */
export type PlanReferenceWhy = "test-file" | "generated" | "low-relevance" | "no-candidate" | "formatting-only" | "window";

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

/* The content lines a piece adds and removes, in order: a hunk's body without its `@@` header, a whole file section without its `---`/`+++` header lines. */
function contentLines(piece: PlanDiffPiece): { added: string[]; removed: string[] } {
  const lines = piece.text.split("\n");
  const body = piece.range ? lines.slice(1) : lines.filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  return {
    added: body.filter((line) => line.startsWith("+")).map((line) => line.slice(1)),
    removed: body.filter((line) => line.startsWith("-")).map((line) => line.slice(1)),
  };
}

/* Whether the piece changes no code, only how it is laid out: its added lines and its removed lines are the same once the runs of whitespace are normalised and the blank lines dropped. Pure text, never a parser. */
function formattingOnly(piece: PlanDiffPiece): boolean {
  const { added, removed } = contentLines(piece);
  const shape = (lines: readonly string[]): string[] => lines.map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "");
  const before = shape(removed);
  return before.length > 0 && before.join("\n") === shape(added).join("\n");
}

/* A piece of the diff with what places it: the file it is in and its rank in the slice's order. */
interface DiffPieceEntry {
  piece: PlanDiffPiece;
  file: ChangeMapFile | undefined;
  rank: [number, number, number];
}

/* Why the selection holds a piece back, or undefined when a prompt may show it: its file's kind (never shown, whatever it overlaps), a change of whitespace alone, or no candidate standing on it. */
function selectionWhy(entry: DiffPieceEntry): PlanReferenceWhy | undefined {
  const kind = referenceOnlyWhy(entry.file);
  if (kind !== undefined) return kind;
  if (formattingOnly(entry.piece)) return "formatting-only";
  return entry.piece.candidateIds.length > 0 ? undefined : "no-candidate";
}

/* Why each piece of the diff is named instead of shown, in diff order: the selection a run with candidates gets, or the earlier treatment when no piece is backed (never an empty diff). */
function planWhys(entries: readonly DiffPieceEntry[], candidates: readonly UseCaseCandidate[]): Array<PlanReferenceWhy | undefined> {
  const byKind = entries.map((entry) => referenceOnlyWhy(entry.file));
  const selecting = candidates.length > 0 && entries.some((entry) => entry.piece.candidateIds.length > 0);
  if (!selecting) return byKind;
  const selected = entries.map(selectionWhy);
  return selected.includes(undefined) ? selected : byKind;
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
  const entries: DiffPieceEntry[] = [];
  let order = 0;
  for (const section of diff.split(/^(?=diff --git )/m)) {
    if (section.trim() === "") continue;
    const path = sectionPath(section);
    const file = files.get(path);
    const kind: FileKind = file?.kind ?? "other";
    const classRank = FILE_CLASS_ORDER.indexOf(file?.fileClass ?? "other");
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
      entries.push({ piece, file, rank: [classRank, decision, order] });
      order++;
    }
  }
  const whys = planWhys(entries, candidates);
  const ranked: Array<PlanDiffPiece & { rank: [number, number, number] }> = [];
  const referenceOnly: PlanDiff["referenceOnly"] = [];
  entries.forEach(({ piece, rank }, i) => {
    const why = whys[i];
    if (why !== undefined) referenceOnly.push({ ...piece, why });
    else ranked.push({ ...piece, rank });
  });
  ranked.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  return { map, ranked: ranked.map(({ rank: _rank, ...piece }) => piece), referenceOnly };
}

/* Where a piece is: `path:start-end` for a hunk, the path alone for a whole file section. */
export function pieceLocation(piece: Pick<PlanDiffPiece, "path" | "range">): string {
  return piece.range ? `${piece.path}:${piece.range.start}-${piece.range.end}` : piece.path;
}
