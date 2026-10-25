/*
 * Whether a stored context map still describes the commit a run tests, decided from git alone (no agent turn).
 *
 * A map is built by an agent from a commit and is stored under that commit's sha. A run at another sha may still
 * reuse it when nothing the map was derived from differs between the two commits: the files the map itself names
 * (each route's `source` and `implementationFiles`, each operation's `spec`) are the same bytes, and no file of the
 * same kind as a route source (same name suffix, e.g. `.routes.ts`) was added. Whichever commit is the newer one, the
 * rule is the same: it compares two trees and makes no ancestry claim. When the two trees cannot be compared
 * (a missing commit, a git failure), the map is not known to fit and is not reused.
 *
 * What the map names is the only derivation input this rule can see: a generated client that feeds `feBe` is not
 * named, so the 14-day age bound still applies to a map that passes.
 */

export interface ChangedFile {
  /* git's single-letter status without renames: A added, D deleted, M modified, T type changed. */
  status: string;
  path: string;
}

export type ContextMapValidity =
  | { valid: true; reason: "same-sha" | "inputs-unchanged" }
  | { valid: false; reason: "inputs-changed" | "unverifiable" };

interface MapFiles {
  routes?: ReadonlyArray<{ source?: unknown; implementationFiles?: unknown }>;
  api?: ReadonlyArray<{ spec?: unknown }>;
}

const normalized = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

/* Everything after the first dot of the base name: `login.routes.ts` -> `.routes.ts`. A name without a dot has no kind. */
function kindOf(path: string): string | undefined {
  const base = normalized(path).split("/").pop() ?? "";
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(dot) : undefined;
}

function namedFiles(map: MapFiles): { named: Set<string>; sourceKinds: Set<string> } {
  const named = new Set<string>();
  const sourceKinds = new Set<string>();
  for (const route of map.routes ?? []) {
    if (typeof route.source === "string" && route.source.trim() !== "") {
      named.add(normalized(route.source));
      const kind = kindOf(route.source);
      if (kind) sourceKinds.add(kind);
    }
    if (Array.isArray(route.implementationFiles)) {
      for (const file of route.implementationFiles) if (typeof file === "string") named.add(normalized(file));
    }
  }
  for (const operation of map.api ?? []) {
    if (typeof operation.spec === "string" && operation.spec.trim() !== "") named.add(normalized(operation.spec));
  }
  return { named, sourceKinds };
}

/* `changes` is the difference between the map's commit and the run's commit; undefined when it could not be read. */
export function contextMapValidity(
  map: MapFiles,
  capturedSha: string,
  runSha: string,
  changes: readonly ChangedFile[] | undefined,
): ContextMapValidity {
  if (capturedSha === runSha) return { valid: true, reason: "same-sha" };
  if (changes === undefined) return { valid: false, reason: "unverifiable" };
  const { named, sourceKinds } = namedFiles(map);
  for (const change of changes) {
    const path = normalized(change.path);
    if (named.has(path)) return { valid: false, reason: "inputs-changed" };
    if (change.status === "A") {
      const kind = kindOf(path);
      if (kind && sourceKinds.has(kind)) return { valid: false, reason: "inputs-changed" };
    }
  }
  return { valid: true, reason: "inputs-unchanged" };
}

/* Parses `git diff --name-status --no-renames -z` output: status, NUL, path, NUL, ... */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const parts = output.split("\0");
  const out: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.trim();
    if (status === "") continue;
    out.push({ status: status[0]!, path: parts[i + 1]! });
  }
  return out;
}
