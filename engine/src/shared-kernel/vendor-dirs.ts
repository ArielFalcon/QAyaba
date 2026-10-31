/* Vendor and build directories: never a genuine source of the repository, so a walk that reads its sources for something other than the suite (a boundary resolver, the consumer's expectations) skips them. */
export const SKIP_VENDOR_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".cache"]);
