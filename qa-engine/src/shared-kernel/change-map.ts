/*
 * The change as the run's diff shows it, one entry per changed file and never cut: path, the kind the language registry gives
 * it, lines added and removed, whether it is an app test file, its relevance class, and the candidates its changed code seeds
 * (a seed or a shared seed). Pure and deterministic: files in diff order. A slice for one flow is cut from it (change-slice.ts).
 * It also holds the one seed definition every reader of a candidate's seeds goes through (`candidateSeeds`, `seedingOf`,
 * `candidatesSeededBy`): the map, the slices, the briefs and the routing of a finding by the file it names ask the same question.
 */
import { LanguageRegistry, type LanguageId } from "./language-id.ts";
import { classifyPath, type FileClass } from "./file-classes.ts";
import { sectionPath, sectionStat } from "./diff-hunks.ts";
import { normalizeSpecPath } from "./spec-path.ts";
import type { ChangedSymbol } from "./change-reach.ts";
import type { UseCaseCandidate } from "./use-case-candidate.ts";

/* The seeds a candidate is read by: its own changed code, and the changed code a hub carries to its page together with others. */
export type SeededCandidate = Pick<UseCaseCandidate, "seeds" | "sharedSeeds">;

/* How a changed file seeds a candidate: through one of its own seeds, or only through a hub's code the candidate shares with other pages. */
export type Seeding = "direct" | "shared";

/* Every changed symbol a candidate stands on: its seeds, then its shared seeds. Both own the hunks they hold, and a finding about either's file is the candidate's. */
export function candidateSeeds(candidate: SeededCandidate): ChangedSymbol[] {
  return [...candidate.seeds, ...(candidate.sharedSeeds ?? [])];
}

/* Whether two repository-relative paths name one file: equality of their canonical form, never a suffix, so a same-named file under another package of a monorepo is another file. */
const sameFile = (a: string, b: string): boolean => normalizeSpecPath(a) === normalizeSpecPath(b);

/* How `file` seeds the candidate: `direct` when one of its seeds is in the file, `shared` when only a shared seed is, undefined when none is. */
export function seedingOf(file: string, candidate: SeededCandidate): Seeding | undefined {
  if (candidate.seeds.some((seed) => sameFile(seed.file, file))) return "direct";
  return (candidate.sharedSeeds ?? []).some((seed) => sameFile(seed.file, file)) ? "shared" : undefined;
}

/* The candidates `file` seeds: those it seeds directly first, then those it seeds only as shared code, each in the order given. */
export function candidatesSeededBy<C extends SeededCandidate>(file: string, candidates: readonly C[]): C[] {
  const direct = candidates.filter((candidate) => seedingOf(file, candidate) === "direct");
  return [...direct, ...candidates.filter((candidate) => seedingOf(file, candidate) === "shared")];
}

/* A file's kind as a reader sees it: a declared language, or `other` (styles, templates, data). */
export type FileKind = LanguageId | "other";

export function fileKindOf(file: string): FileKind {
  return LanguageRegistry.languageForFile(file) ?? "other";
}

export interface ChangeMapFile {
  path: string;
  kind: FileKind;
  added: number;
  removed: number;
  status: "new" | "deleted" | "modified";
  fileClass: FileClass;
  isTest: boolean;
  /* The ids of the candidates whose seeds or shared seeds are in this file, in candidate order. */
  seededBy: string[];
}

/* The changed code a candidate stands on: its seeds and shared seeds, which both own hunks of a slice. */
export interface ChangeMapCandidate {
  id: string;
  seeds: ChangedSymbol[];
}

export interface ChangeMap {
  files: ChangeMapFile[];
  candidates: ChangeMapCandidate[];
}

export function buildChangeMap(input: { diff: string; candidates: readonly UseCaseCandidate[] }): ChangeMap {
  const candidates: ChangeMapCandidate[] = input.candidates.map((candidate) => ({
    id: candidate.id,
    seeds: candidateSeeds(candidate),
  }));
  const files = new Map<string, ChangeMapFile>();
  for (const section of input.diff.split(/^(?=diff --git )/m)) {
    const path = sectionPath(section);
    if (path === "") continue;
    const stat = sectionStat(section);
    const known = files.get(path);
    if (known) {
      known.added += stat.added;
      known.removed += stat.removed;
      continue;
    }
    files.set(path, {
      path,
      kind: fileKindOf(path),
      added: stat.added,
      removed: stat.removed,
      status: stat.status,
      fileClass: classifyPath(path),
      isTest: LanguageRegistry.isTestFile(path),
      seededBy: candidates.filter((c) => seedingOf(path, c) !== undefined).map((c) => c.id),
    });
  }
  return { files: [...files.values()], candidates };
}

/* One changed file as a list line: `- path (+added -removed[, new file|, deleted])`. The line a prompt uses for a file it names without showing. */
export function changeFileLine(file: Pick<ChangeMapFile, "path" | "added" | "removed" | "status">): string {
  const note = file.status === "new" ? ", new file" : file.status === "deleted" ? ", deleted" : "";
  return `- ${file.path} (+${file.added} -${file.removed}${note})`;
}
