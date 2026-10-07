/* A spec path in the one canonical form every comparison of two spec files goes through: forward slashes, no `.` segment, no empty segment (a repeated or trailing separator) and no leading "./". Two reports of the same file, by whoever spelled them, are equal exactly when their canonical forms are. Nothing else is rewritten, so that the confined reader still sees and refuses what it refuses: a `..` segment stays where it stands (it is not resolved, which would hide a climb out of the spec directory) and an absolute path stays absolute. A path with nothing left names no file in the spec directory and is empty. */
export function normalizeSpecPath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  return (slashed.startsWith("/") ? "/" : "") + segments.join("/");
}
