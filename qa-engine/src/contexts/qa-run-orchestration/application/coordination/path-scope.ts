// Writable-path scope checks for sidekick pushback / executor (shared — one semantics).
// "." / "./" means "any relative path under cwd" without ".." or absolute escapes.

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
    if (r === "." || r === "./") return true;
    if (normalized === r || normalized === r.replace(/\/$/, "")) return true;
    const prefix = r.endsWith("/") ? r : `${r}/`;
    return normalized.startsWith(prefix);
  });
}
