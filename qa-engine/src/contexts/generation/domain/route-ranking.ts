/* Which of the map's routes the run's changed files point at, so the pack offers those to the capture first. Only declared paths count: the files that implement a route, the file that declares it, and the spec of an operation it joins; after them, the pages of the change's use-case candidates (`candidates`, derived outside and passed in) by how directly the change reaches them, and last before the rest the pages a hub of the change reaches (`hubPages`), which are never change pages. Nothing is inferred from a name, a substring or a service label, and a map that declares none of them, or none that changed, leaves the order as the file has it. The map is data read from a file: every field is checked where it is read, and one that is not what it should be is skipped, never thrown on. */

import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

/* Why a page of the app's map is one of the change's pages: the map links it (a changed file implements it, declares it, or is the spec of an operation it joins), or the call graph reaches it. */
export type ChangePageBasis = "implementation" | "source" | "spec" | "graph";

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
  /* The use cases the change makes testable. Their pages rank after every page the map links, direct before indirect before cross-repo, and a page the map links keeps the map's basis. */
  candidates?: readonly UseCaseCandidate[];
  /* Pages a hub of the change reaches: too many for the graph to name any as a change page, so none is relevant, but they rank after every change page and before the rest, so the capture shows pages the change does reach. */
  hubPages?: readonly string[];
}

/* A suffix links two paths only when it spans this many segments, so a bare file name never does; across repos an equal path needs as many, while in a single repo a file at the root names itself. */
const MIN_SEGMENTS_OF_A_SUFFIX = 2;
const MIN_SEGMENTS_ACROSS_REPOS = 2;
const MIN_SEGMENTS_IN_A_SINGLE_REPO = 1;

/* The smaller the rank, the earlier the route. */
const RANK = { implementation: 0, source: 1, spec: 2, direct: 3, indirect: 4, "cross-repo": 5, hub: 6, rest: 7 } as const;
const BASIS_OF_RANK: Record<number, ChangePageBasis> = { [RANK.implementation]: "implementation", [RANK.source]: "source", [RANK.spec]: "spec", [RANK.direct]: "graph", [RANK.indirect]: "graph", [RANK["cross-repo"]]: "graph" };
/* The bases a candidate page can share with the map's own links; any other basis is the call graph's. */
const MAP_BASES: ReadonlySet<string> = new Set<ChangePageBasis>(["implementation", "source", "spec"]);

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

/* One route with the rank its declared links gave it. `relevant` is false only when the change names nothing on the route; a relevant route names why (`basis`). */
export interface RankedRoute {
  route: string;
  rank: number;
  relevant: boolean;
  basis?: ChangePageBasis;
  /* The changed files, spelled as the change gave them, that the map links to the route (its implementation files, its source, the spec of an operation it joins); empty for a route only the call graph reaches. */
  files: string[];
}

/* The changed files (spelled as given) the map links to a page of the app: the ones a route declares as an implementation file, which already include the non-code files those declare, or as its source. A single repo only: across repos the changed files are the service's, and nothing here links them. */
export function filesLinkedToPages(map: RankableMap | undefined, changedFiles: readonly string[]): Set<string> {
  const declared = entriesOf(map?.routes).flatMap((entry) => {
    const implementationFiles = entry[ROUTE_LINK_FIELDS.implementationFiles];
    return [...(isPathList(implementationFiles) ? implementationFiles : []), ...(isText(entry[ROUTE_LINK_FIELDS.source]) ? [entry[ROUTE_LINK_FIELDS.source] as string] : [])].map(normalize);
  });
  return new Set(
    changedFiles.filter((file) => {
      const path = normalize(file);
      return path !== "" && declared.some((link) => link !== "" && sameFile(link, path, MIN_SEGMENTS_IN_A_SINGLE_REPO));
    }),
  );
}

export function rankRoutesWithRelevance(routes: readonly string[], map: RankableMap | undefined, change: RankingChange): RankedRoute[] {
  const roots = change.stagedRoots?.filter(isText).map(normalize);
  const crossRepo = roots !== undefined;
  const minEqualSegments = crossRepo ? MIN_SEGMENTS_ACROSS_REPOS : MIN_SEGMENTS_IN_A_SINGLE_REPO;
  /* The changed files a declared path names, in the change's own spelling. */
  const changedNamedBy = (declared: unknown): string[] => {
    const path = pathToCompare(declared, roots);
    return path === undefined ? [] : change.changedFiles.filter(isText).filter((file) => { const n = normalize(file); return n !== "" && sameFile(path, n, minEqualSegments); });
  };
  const isChanged = (declared: unknown): boolean => changedNamedBy(declared).length > 0;

  const specFilesOfOperation = new Map<unknown, string[]>();
  for (const operation of entriesOf(map?.api)) {
    const files = changedNamedBy(operation[ROUTE_LINK_FIELDS.spec]);
    if (files.length > 0) specFilesOfOperation.set(operation.operationId, files);
  }
  const specFilesOfRoute = new Map<unknown, string[]>();
  for (const link of entriesOf(map?.feBe)) {
    const files = typeof link.operationId === "string" ? specFilesOfOperation.get(link.operationId) : undefined;
    if (files !== undefined) specFilesOfRoute.set(link.route, [...(specFilesOfRoute.get(link.route) ?? []), ...files]);
  }
  const routesJoiningThem = new Set<unknown>(specFilesOfRoute.keys());

  /* What one entry of the map says about its route. A path the map lists twice has the better of its entries' ranks, so a bare entry never erases the links of another. */
  const ownRank = (entry: Record<string, unknown>): number => {
    const implementationFiles = entry[ROUTE_LINK_FIELDS.implementationFiles];
    if (isPathList(implementationFiles) && implementationFiles.some(isChanged)) return RANK.implementation;
    return isChanged(entry[ROUTE_LINK_FIELDS.source]) ? RANK.source : RANK.rest;
  };
  const routeEntries = entriesOf(map?.routes);
  /* The best place a candidate page earns by its tier, with the basis it was reached by. */
  const candidatePlace = new Map<string, { rank: number; basis?: ChangePageBasis }>();
  for (const c of change.candidates ?? []) {
    if (c.entry.kind !== "page") continue;
    const rank = RANK[c.tier];
    const held = candidatePlace.get(c.entry.route);
    if (held === undefined || rank < held.rank) candidatePlace.set(c.entry.route, { rank, ...(MAP_BASES.has(c.basis) ? { basis: c.basis as ChangePageBasis } : {}) });
  }
  const reachedByHub = new Set(change.hubPages ?? []);
  const rankOf = (route: string): number =>
    Math.min(
      routesJoiningThem.has(route) ? RANK.spec : RANK.rest,
      candidatePlace.get(route)?.rank ?? RANK.rest,
      reachedByHub.has(route) ? RANK.hub : RANK.rest,
      ...routeEntries.filter((entry) => !crossRepo && entry.path === route).map(ownRank),
    );
  const linkingFiles = (route: string): string[] => {
    const own = crossRepo ? [] : routeEntries.filter((entry) => entry.path === route).flatMap((entry) => {
      const implementationFiles = entry[ROUTE_LINK_FIELDS.implementationFiles];
      return [...(isPathList(implementationFiles) ? implementationFiles.flatMap(changedNamedBy) : []), ...changedNamedBy(entry[ROUTE_LINK_FIELDS.source])];
    });
    return [...new Set([...own, ...(specFilesOfRoute.get(route) ?? [])])];
  };
  const all = [...new Set([...routes, ...candidatePlace.keys()])];
  return all
    .map((route) => {
      const rank = rankOf(route);
      const relevant = rank < RANK.hub;
      const place = candidatePlace.get(route);
      const basis = place !== undefined && place.rank === rank && place.basis !== undefined ? place.basis : BASIS_OF_RANK[rank];
      return { route, rank, relevant, ...(relevant ? { basis: basis! } : {}), files: linkingFiles(route) };
    })
    .sort((a, b) => a.rank - b.rank);
}
