/* Adds to each route of the architecture map the files its implementation files declare: a page whose template and style sheets are separate files is changed through those, so a change to one of them has to reach the route. Only what an implementation file says counts (the relative path literals of `declaredRelativeFiles`), and only a regular file that is there, below the working copy, with no link anywhere on the way. A sibling is never guessed from a name. The working copy is a directory the agent can write into and the map came from it, so every read and probe goes through the strict calls of the confinement module. Fail-open and bounded: a file that cannot be read or found adds nothing, and nothing it holds is ever quoted. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { ArchitectureContext } from "@contexts/generation/application/index.ts";
import { declaredRelativeFiles } from "@contexts/generation/application/index.ts";
import { LanguageRegistry } from "@kernel/language-id.ts";
import { MAX_SPEC_SOURCE_BYTES, probeOwnedSpecFile, readOwnedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";

/* An implementation file larger than this is not read: a page is a few hundred lines. */
export const MAX_DECLARED_RESOURCE_SOURCE_BYTES = MAX_SPEC_SOURCE_BYTES;
/* The most implementation files read for one route, the most files added to one, and the most files read in all for a map. */
export const MAX_IMPLEMENTATION_FILES_READ_PER_ROUTE = 8;
export const MAX_DECLARED_FILES_PER_ROUTE = 16;
export const MAX_IMPLEMENTATION_FILES_READ_PER_MAP = 400;

const isSourceCode = (file: string): boolean => LanguageRegistry.languageForFile(file) !== null;

/* The declared files of one implementation file that are regular files of the working copy, `[]` for a file that is not there, or undefined when it could not be read (a link, too large, unreadable). */
function declaredBy(root: SpecRoot, file: string): string[] | undefined {
  try {
    const read = readOwnedSpecFile(root, file, MAX_DECLARED_RESOURCE_SOURCE_BYTES);
    if ("absent" in read) return [];
    if (!("bytes" in read)) return undefined;
    return declaredRelativeFiles(read.bytes.toString("utf8"), file, isSourceCode).filter((declared) => probeOwnedSpecFile(root, declared) === "file");
  } catch {
    return undefined;
  }
}

/* The map with each route's implementationFiles followed by the files they declare. A route that gains none, and a map that gains none, is returned as it came. */
export function withDeclaredResources(map: ArchitectureContext, mirrorDir: string): ArchitectureContext {
  const root: SpecRoot = { mirrorDir, specDir: mirrorDir };
  const cache = new Map<string, string[] | undefined>();
  let unread = 0;
  let gained = false;
  const read = (file: string): string[] | undefined => {
    if (!cache.has(file)) {
      if (cache.size >= MAX_IMPLEMENTATION_FILES_READ_PER_MAP) return undefined;
      const declared = declaredBy(root, file);
      if (declared === undefined) unread += 1;
      cache.set(file, declared);
    }
    return cache.get(file);
  };

  const routes = map.routes.map((route) => {
    const own = route.implementationFiles;
    if (!Array.isArray(own) || own.length === 0) return route;
    const known = new Set(own);
    const added: string[] = [];
    for (const file of own.slice(0, MAX_IMPLEMENTATION_FILES_READ_PER_ROUTE)) {
      for (const declared of read(file) ?? []) {
        if (added.length >= MAX_DECLARED_FILES_PER_ROUTE) break;
        if (known.has(declared)) continue;
        known.add(declared);
        added.push(declared);
      }
    }
    if (added.length === 0) return route;
    gained = true;
    return { ...route, implementationFiles: [...own, ...added] };
  });
  /* A count only: the names of the files and what they hold stay out of the log. */
  if (unread > 0) engineLog.warn(`[qa] WARNING: ${unread} implementation files of the context map could not be read for the files they declare (non-blocking).`);
  return gained ? { ...map, routes } : map;
}
