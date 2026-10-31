/* For each label a diff changed, how many unchanged lines of its file already hold it, read from the working copy at the commit. A page that shows a changed label as many times as unchanged lines hold it may be showing only those lines, so the count is what tells the pack (and the DOM marks) whether the change itself rendered. The working copy is a directory the agent can write into and the diff names the paths, so each file is read through the strict reader of the confinement module. Fail-open and bounded: a file that is not there, is a link or is too large gives no count, and nothing it holds is ever quoted. */

import type { ChangedElement } from "@kernel/diff-parser/changed-element.ts";
import type { ChangedLines } from "@kernel/diff-parser/changed-lines.ts";
import type { ChangedLiteral } from "@kernel/diff-parser/changed-literal.ts";
import { countUnchangedLinesHolding } from "@contexts/generation/domain/unchanged-lines.ts";
import { MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";

/* The most distinct files read for one diff: the labels of a diff come from a few files, and a rewrite of the app says no more by reading them all. */
export const MAX_FILES_READ_FOR_LABELS = 24;

export interface MeasuredLabels {
  literals: ChangedLiteral[];
  elements: ChangedElement[];
}

export function withUnchangedLines(
  mirrorDir: string,
  changedLines: ChangedLines,
  literals: readonly ChangedLiteral[],
  elements: readonly ChangedElement[],
): MeasuredLabels {
  const root: SpecRoot = { mirrorDir, specDir: mirrorDir };
  const sources = new Map<string, string | undefined>();
  const sourceOf = (file: string): string | undefined => {
    if (!sources.has(file)) {
      if (sources.size >= MAX_FILES_READ_FOR_LABELS) return undefined;
      let text: string | undefined;
      try {
        const read = readOwnedSpecFile(root, file, MAX_SPEC_SOURCE_BYTES);
        text = "bytes" in read ? read.bytes.toString("utf8") : undefined;
      } catch {
        text = undefined;
      }
      sources.set(file, text);
    }
    return sources.get(file);
  };
  const countFor = (file: string, value: string): number | undefined => {
    const source = sourceOf(file);
    return source === undefined ? undefined : countUnchangedLinesHolding(source, changedLines.get(file), value);
  };
  return {
    literals: literals.map((literal) => {
      const unchangedLines = countFor(literal.file, literal.value);
      return unchangedLines === undefined ? literal : { ...literal, unchangedLines };
    }),
    elements: elements.map((element) => {
      const textOnly = element.text !== undefined && element.testId === undefined && element.id === undefined && element.name === undefined && element.href === undefined;
      const unchangedLines = textOnly && element.file !== "" ? countFor(element.file, element.text!) : undefined;
      return unchangedLines === undefined ? element : { ...element, unchangedLines };
    }),
  };
}
