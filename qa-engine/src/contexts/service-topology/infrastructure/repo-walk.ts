/* service-topology/infrastructure/repo-walk.ts What the boundary resolvers share when they walk and read the repositories of a system. The files are listed and read through one RepoReader (shared-infrastructure): a mirror is a directory the agent writes into, so no link is followed, no named pipe is opened, and neither the entries looked at nor the size of a file is unbounded. The walk visits the entries in the order of their names (project invariant #1: stable, deterministic behavior; readdir order is filesystem-dependent), which matters to a resolver whose join is first-match-wins. Vendor/build directories are skipped — they are never a genuine call-site. */

export const SKIP_VENDOR_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", ".cache",
]);

/* A source file a resolver parses, and an OpenAPI document: far beyond what a person writes by hand (a generated client or a very large API description can be some megabytes). A file past its cap is skipped and counted, which is what a resolver does with a file it cannot use. */
export const MAX_TOPOLOGY_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_TOPOLOGY_OPENAPI_BYTES = 16 * 1024 * 1024;
