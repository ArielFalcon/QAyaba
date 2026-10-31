/* Writable-path confinement for sidekick pushback and executor (one semantics): a relative path with no ".." or absolute escape, inside one of the writable roots. */

export function isPathWithinWritableRoots(
  filePath: string,
  writableRoots: readonly string[],
): boolean {
  let normalized = filePath.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return false;
  }
  return writableRoots.some((root) => {
    const r = root.replace(/\\/g, "/");
    if (normalized === r || normalized === r.replace(/\/$/, "")) return true;
    const prefix = r.endsWith("/") ? r : `${r}/`;
    return normalized.startsWith(prefix);
  });
}
