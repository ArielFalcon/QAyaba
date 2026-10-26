/*
 * What a map and the engine's routes say about the pages of an app: which files implement each page, and which pages the map
 * joins to each operation. Shared by the reach proofs that start from a page. Pure.
 */
import type { GraphRoute } from "./code/index.ts";

export interface PageFilesDisagreement {
  route: string;
  mapFiles: string[];
  engineFile: string;
}

/* The map sections the join reads; every field is checked where it is read (the map is data from a file). */
export interface PageMap {
  routes?: ReadonlyArray<{ path?: unknown; source?: unknown; implementationFiles?: unknown }>;
  api?: ReadonlyArray<{ operationId?: unknown; method?: unknown; path?: unknown }>;
  feBe?: ReadonlyArray<{ route?: unknown; operationId?: unknown }>;
}

export const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
export const normalizeFile = (path: string): string => path.replaceAll("\\", "/").split("/").filter((s) => s !== "" && s !== ".").join("/");
export const normalizeRoute = (path: string): string => path.split("/").filter(Boolean).join("/");
/* Two repo paths name one file: equal, or one is the other re-rooted by at least two segments (a bare file name never links). */
export const sameFile = (a: string, b: string): boolean => a === b || (b.split("/").length >= 2 && a.endsWith(`/${b}`)) || (a.split("/").length >= 2 && b.endsWith(`/${a}`));
export const keyOf = (s: { file: string; symbol: string }): string => `${s.file}::${s.symbol}`;

const dirSegments = (file: string): string[] => file.split("/").slice(0, -1);
function sharedDirs(a: string, b: string): number {
  const x = dirSegments(a);
  const y = dirSegments(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/*
 * The engine's files for one map route. The engine lists a path once per frontend that declares it, so in a monorepo the nodes
 * are scoped to the one declared nearest the map entry's own source (the most directories shared with the file that declares the
 * route). When the declarations are not told apart (no source, or none shares a directory with it), no frontend is claimed.
 */
function scopeToSource(nodes: ReadonlyArray<{ declaredIn: string; file: string }>, source: string | undefined): string[] {
  const declarations = new Set(nodes.map((n) => n.declaredIn));
  if (declarations.size <= 1) return [...new Set(nodes.map((n) => n.file))];
  if (source === undefined) return [];
  const near = Math.max(...nodes.map((n) => sharedDirs(n.declaredIn, source)));
  if (near === 0) return [];
  return [...new Set(nodes.filter((n) => sharedDirs(n.declaredIn, source) === near).map((n) => n.file))];
}

/* The files that implement each page: the map's own, else the engine's route node for the same path. */
export function pageFiles(map: PageMap, pageRoutes: readonly GraphRoute[]): { files: Map<string, string[]>; disagreements: PageFilesDisagreement[] } {
  const engineFilesOf = new Map<string, Array<{ declaredIn: string; file: string }>>();
  for (const r of pageRoutes) {
    /* The node's own file declares the route (the map's `source`); the page is implemented by the symbol it points at. */
    if (r.method !== undefined || r.target === undefined) continue;
    const files = [normalizeFile(r.target.file)];
    const key = normalizeRoute(r.path);
    engineFilesOf.set(key, [...(engineFilesOf.get(key) ?? []), { declaredIn: normalizeFile(r.file), file: files[0]! }]);
  }
  const files = new Map<string, string[]>();
  const disagreements: PageFilesDisagreement[] = [];
  for (const entry of map.routes ?? []) {
    if (!entry || !isText(entry.path)) continue;
    const declared = Array.isArray(entry.implementationFiles) ? entry.implementationFiles.filter(isText).map(normalizeFile) : [];
    const engine = scopeToSource(engineFilesOf.get(normalizeRoute(entry.path)) ?? [], isText(entry.source) ? normalizeFile(entry.source) : undefined);
    if (declared.length > 0) {
      files.set(entry.path, [...new Set([...(files.get(entry.path) ?? []), ...declared])]);
      const unknown = engine.filter((e) => !declared.some((d) => sameFile(d, e)));
      for (const engineFile of unknown) {
        if (!disagreements.some((d) => d.route === entry.path && d.engineFile === engineFile)) disagreements.push({ route: entry.path, mapFiles: declared, engineFile });
      }
    } else if (engine.length > 0 && !files.has(entry.path)) {
      files.set(entry.path, engine);
    }
  }
  return { files, disagreements };
}

/* The pages the map's feBe joins to each operationId. */
export function pagesByOperation(map: PageMap): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const link of map.feBe ?? []) {
    if (!link || !isText(link.route) || !isText(link.operationId)) continue;
    out.set(link.operationId, [...new Set([...(out.get(link.operationId) ?? []), link.route])]);
  }
  return out;
}
