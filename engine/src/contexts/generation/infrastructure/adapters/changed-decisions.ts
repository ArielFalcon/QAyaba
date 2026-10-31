/* The static decision listing of a diff: each changed file of the change's own code (an app test file is not) is read from the working copy at the commit and handed with its changed lines to the lister the language registry declares for it. The working copy is a directory the agent can write into and the diff names the paths, so each file is read through the strict reader of the confinement module. Bounded and fail-open: a file that is not there, is a link or is too large lists nothing; one that does not parse lists nothing and is named. */

import { LanguageRegistry } from "@kernel/language-id.ts";
import type { ChangedLines } from "@kernel/diff-parser/changed-lines.ts";
import type { DecisionListing } from "@kernel/changed-decision.ts";
import { listDecisions } from "../../../../shared-infrastructure/decision-listing.ts";
import { MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";

/* The most changed files read for one diff; past it the rest list nothing. */
export const MAX_FILES_READ_FOR_DECISIONS = 200;

function sourceOf(root: SpecRoot, file: string): string | undefined {
  try {
    const read = readOwnedSpecFile(root, file, MAX_SPEC_SOURCE_BYTES);
    return "bytes" in read ? read.bytes.toString("utf8") : undefined;
  } catch {
    return undefined;
  }
}

export function changedDecisionsOf(mirrorDir: string, changedLines: ChangedLines): DecisionListing {
  const root: SpecRoot = { mirrorDir, specDir: mirrorDir };
  const listing: DecisionListing = { decisions: [], unparsed: [] };
  const files = [...changedLines].filter(([file]) => LanguageRegistry.decisionSyntaxForFile(file) !== null && !LanguageRegistry.isTestFile(file));
  for (const [file, lines] of files.slice(0, MAX_FILES_READ_FOR_DECISIONS)) {
    if (lines.size === 0) continue;
    const source = sourceOf(root, file);
    if (source === undefined) continue;
    const listed = listDecisions(file, source, lines);
    if ("decisions" in listed) listing.decisions.push(...listed.decisions);
    else if ("unparsed" in listed) listing.unparsed.push(file);
  }
  return listing;
}
