/* Gives each changed element the containers its line sits in, from the file at the run's commit in the working copy, so the pack can mark the one occurrence of a repeated text that the change touched. The working copy is a directory the agent can write into, so the file is read through the strict reader of the confinement module. Fail-open: a file that cannot be read leaves its elements as they came. */

import type { ChangedElement } from "@kernel/diff-parser/changed-element.ts";
import { enclosingScope } from "@contexts/generation/domain/enclosing-scope.ts";
import { readOwnedSpecFile } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { MAX_DECLARED_RESOURCE_SOURCE_BYTES } from "./implementation-resources.ts";

function sourceOf(mirrorDir: string, file: string): string | undefined {
  try {
    const read = readOwnedSpecFile({ mirrorDir, specDir: mirrorDir }, file, MAX_DECLARED_RESOURCE_SOURCE_BYTES);
    return "bytes" in read ? read.bytes.toString("utf8") : undefined;
  } catch {
    return undefined;
  }
}

export function withChangedElementScopes(elements: ChangedElement[], mirrorDir: string, testIdAttr?: string): ChangedElement[] {
  const sources = new Map<string, string | undefined>();
  return elements.map((element) => {
    if (element.file === "" || element.line < 1) return element;
    if (!sources.has(element.file)) sources.set(element.file, sourceOf(mirrorDir, element.file));
    const source = sources.get(element.file);
    const scope = source === undefined ? [] : enclosingScope(source, element.line, testIdAttr);
    return scope.length > 0 ? { ...element, scope } : element;
  });
}
