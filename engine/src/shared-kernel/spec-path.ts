import { relative } from "node:path";

/* A spec path in the one canonical form every comparison of two spec files goes through: forward slashes, no `.` segment, no empty segment (a repeated or trailing separator) and no leading "./". Two reports of the same file, by whoever spelled them, are equal exactly when their canonical forms are. Nothing else is rewritten, so that the confined reader still sees and refuses what it refuses: a `..` segment stays where it stands (it is not resolved, which would hide a climb out of the spec directory) and an absolute path stays absolute. A path with nothing left names no file in the spec directory and is empty. */
export function normalizeSpecPath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  return (slashed.startsWith("/") ? "/" : "") + segments.join("/");
}

/* Whether two spellings name one file: their canonical forms are equal, never a suffix, so a file and a same-named file under another folder of a monorepo are two files. A path that is absent names no file. */
export function sameSpecPath(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normalizeSpecPath(a) === normalizeSpecPath(b);
}

/* Whether `path` is `spec` or a longer path that ends with it at a directory boundary, never inside a name. */
export function endsWithSpecPath(path: string, spec: string): boolean {
  const longer = normalizeSpecPath(path);
  const tail = normalizeSpecPath(spec);
  return longer === tail || longer.endsWith(`/${tail}`);
}

/* Whether two specs are one file when the directory the suite sits in is not at hand (a stored record names a spec from the repository root, a report from the test directory): either path ends with the other at a directory boundary. */
export function sameSpecPathByTail(a: string, b: string): boolean {
  return endsWithSpecPath(a, b) || endsWithSpecPath(b, a);
}

/* Where a run's spec directory sits under its mirror, in canonical form (empty when the suite sits at the mirror's root): the prefix agents spell in front of a spec path. */
export function specRelDirOf(root: { readonly mirrorDir: string; readonly specDir: string }): string {
  return normalizeSpecPath(relative(root.mirrorDir, root.specDir));
}

/*
 * The suite-relative spec a reference reported by an agent names, or undefined when it names no spec of the suite. Agents spell the
 * same file with or without the spec directory (`e2e/flows/x.spec.ts`, `flows/x.spec.ts`), with a leading `./`, backslashes or a
 * `#clause` suffix; all of them resolve to `flows/x.spec.ts`. Refused: an absolute path, one that climbs out of the spec directory,
 * a hidden directory (the probe directory) and any file that is not a `.spec.ts`.
 */
/* A spec path inside prose: any run of characters up to `.spec.ts`, not crossing whitespace, a `#` clause marker, a quote or a bracket (Unicode names and `@scope` folders included). */
const SPEC_IN_TEXT = /[^\s#"'`()[\]<>]+\.spec\.ts/u;

/*
 * The one place a spec path is pulled out of free text (a citation or a rebuttal reference) and resolved: the suite-relative spec
 * the text names, or undefined when it names none (see `resolveSpecReference`).
 */
export function resolveCitedSpec(text: string, specRelDir: string): string | undefined {
  const named = SPEC_IN_TEXT.exec(text)?.[0];
  return named === undefined ? undefined : resolveSpecReference(named, specRelDir);
}

export function resolveSpecReference(raw: string, specRelDir: string): string | undefined {
  const path = normalizeSpecPath(raw.split("#")[0]!);
  if (path === "" || path.startsWith("/")) return undefined;
  const dir = normalizeSpecPath(specRelDir);
  const rel = dir !== "" && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
  if (!rel.endsWith(".spec.ts")) return undefined;
  return rel.split("/").some((segment) => segment === ".." || segment.startsWith(".")) ? undefined : rel;
}
