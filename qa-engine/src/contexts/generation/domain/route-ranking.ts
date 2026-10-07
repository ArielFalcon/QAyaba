/* Which of the map's routes the run's changed files point at, so the pack offers those to the capture first. Only declared paths count: the files that implement a route, the file that declares it, and the spec of an operation it joins. Nothing is inferred from a name, a substring or a service label, and a map that declares none of them, or none that changed, leaves the order as the file has it. The map is data read from a file: every field is checked where it is read, and one that is not what it should be is skipped, never thrown on. */

/* The map fields this module reads, named once so the skill that teaches the map and its reader cannot drift apart. */
export const ROUTE_LINK_FIELDS = { implementationFiles: "implementationFiles", source: "source", spec: "spec" } as const;

/* The sections of the architecture map this module reads. Each holds entries it checks itself, so a map that is not what its type says is still accepted; the pack's own `ArchitectureContext` is one. */
export interface RankableMap {
  routes?: unknown;
  api?: unknown;
  feBe?: unknown;
}

export interface RankingChange {
  /* The run's changed files, as its diff names them. */
  changedFiles: readonly string[];
  /* Present on a cross-repo run only: where the triggering service's snapshot was staged, as a map may name that place. The changed files are then the service's own, and only the spec of an operation, under one of these roots, can link a route to them (by its path inside the snapshot): a route's own files and the file that declares it belong to the other repo. An empty list is still a cross-repo run: nothing can be attributed to the service. */
  stagedRoots?: readonly string[];
}

/* A suffix links two paths only when it spans this many segments, so a bare file name never does; across repos an equal path needs as many, while in a single repo a file at the root names itself. */
const MIN_SEGMENTS_OF_A_SUFFIX = 2;
const MIN_SEGMENTS_ACROSS_REPOS = 2;
const MIN_SEGMENTS_IN_A_SINGLE_REPO = 1;

/* The smaller the rank, the earlier the route. */
const RANK = { implementation: 0, source: 1, spec: 2, rest: 3 } as const;

const isText = (value: unknown): value is string => typeof value === "string";
/* The entries of a section of the map that is a list. Each entry is read property by property and checked where it is used, so an entry that is not an object only ever reads as having nothing; a missing one has nothing to read at all. */
const entriesOf = (section: unknown): Array<Record<string, unknown>> => (Array.isArray(section) ? section.filter(Boolean) : []);
/* A list of paths is well formed only when every entry is a path: one that is not is skipped whole. */
const isPathList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

/* One spelling for a path: forward slashes, no leading or doubled separator, no `.` segment. */
const normalize = (path: string): string => path.replaceAll("\\", "/").split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
const segmentCount = (path: string): number => path.split("/").length;

/* Whether a path is the other one re-rooted: it ends with it from a segment on, and the suffix spans enough segments to be more than a file name. */
const endsWithSuffix = (path: string, suffix: string): boolean => segmentCount(suffix) >= MIN_SEGMENTS_OF_A_SUFFIX && path.endsWith(`/${suffix}`);

/* Whether two normalized paths name one file: they are equal, or either is the other re-rooted. */
const sameFile = (a: string, b: string, minEqualSegments: number): boolean =>
  a === b ? segmentCount(a) >= minEqualSegments : endsWithSuffix(a, b) || endsWithSuffix(b, a);

/* The declared path as it is compared with the changed files, or nothing when it cannot name one of them: itself in a single repo; across repos only a path under a staged root counts, as the path inside that snapshot. */
function pathToCompare(declared: unknown, roots: readonly string[] | undefined): string | undefined {
  if (!isText(declared)) return undefined;
  const path = normalize(declared);
  if (roots === undefined) return path;
  const root = roots.find((candidate) => path.startsWith(`${candidate}/`));
  return root === undefined ? undefined : path.slice(root.length + 1);
}

export function rankRoutesByChange(routes: readonly string[], map: RankableMap | undefined, change: RankingChange): string[] {
  const changed = change.changedFiles.filter(isText).map(normalize).filter((file) => file !== "");
  const roots = change.stagedRoots?.filter(isText).map(normalize);
  const crossRepo = roots !== undefined;
  const minEqualSegments = crossRepo ? MIN_SEGMENTS_ACROSS_REPOS : MIN_SEGMENTS_IN_A_SINGLE_REPO;
  const isChanged = (declared: unknown): boolean => {
    const path = pathToCompare(declared, roots);
    return path !== undefined && changed.some((file) => sameFile(path, file, minEqualSegments));
  };

  const operationsWithChangedSpec = new Set<unknown>(entriesOf(map?.api).filter((operation) => isChanged(operation[ROUTE_LINK_FIELDS.spec])).map((operation) => operation.operationId));
  const routesJoiningThem = new Set<unknown>(
    entriesOf(map?.feBe)
      .filter((link) => typeof link.operationId === "string" && operationsWithChangedSpec.has(link.operationId))
      .map((link) => link.route),
  );

  /* What one entry of the map says about its route. A path the map lists twice has the better of its entries' ranks, so a bare entry never erases the links of another. */
  const ownRank = (entry: Record<string, unknown>): number => {
    const implementationFiles = entry[ROUTE_LINK_FIELDS.implementationFiles];
    if (isPathList(implementationFiles) && implementationFiles.some(isChanged)) return RANK.implementation;
    return isChanged(entry[ROUTE_LINK_FIELDS.source]) ? RANK.source : RANK.rest;
  };
  const routeEntries = entriesOf(map?.routes);
  const rankOf = (route: string): number =>
    Math.min(
      routesJoiningThem.has(route) ? RANK.spec : RANK.rest,
      ...routeEntries.filter((entry) => !crossRepo && entry.path === route).map(ownRank),
    );
  return routes
    .map((route) => ({ route, rank: rankOf(route) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ route }) => route);
}
