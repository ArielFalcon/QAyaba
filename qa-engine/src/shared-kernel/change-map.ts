/*
 * The change as the run's diff shows it, one entry per changed file and never cut: path, the kind the language registry gives
 * it, lines added and removed, whether it is an app test file, its relevance class, and the candidates its changed code seeds
 * (a seed or a shared seed). Pure and deterministic: files in diff order. A slice for one flow is cut from it (change-slice.ts).
 */
import { LanguageRegistry, type LanguageId } from "./language-id.ts";
import { classifyPath, type FileClass } from "./file-classes.ts";
import { sectionPath, sectionStat } from "./diff-hunks.ts";
import type { ChangedSymbol } from "./change-reach.ts";
import type { UseCaseCandidate } from "./use-case-candidate.ts";

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
    seeds: [...candidate.seeds, ...(candidate.sharedSeeds ?? [])],
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
      seededBy: candidates.filter((c) => c.seeds.some((seed) => seed.file === path)).map((c) => c.id),
    });
  }
  return { files: [...files.values()], candidates };
}

/* One changed file as a list line: `- path (+added -removed[, new file|, deleted])`. The line a prompt uses for a file it names without showing. */
export function changeFileLine(file: Pick<ChangeMapFile, "path" | "added" | "removed" | "status">): string {
  const note = file.status === "new" ? ", new file" : file.status === "deleted" ? ", deleted" : "";
  return `- ${file.path} (+${file.added} -${file.removed}${note})`;
}
