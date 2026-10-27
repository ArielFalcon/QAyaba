/*
 * The route table of a repository at head and at the run's base, for the availability classification. The framework comes from
 * the repository's manifest (the language registry's route-table declarations); the files that hold route configuration are found
 * by a bounded walk of the working copy; head files are read from the working copy through the strict reader of the confinement
 * module (the agent can write into it), and a file the diff changed is read at the base through the injected git reader (the
 * confined mirror reader). A repository whose manifest names no declared framework, or a run with no base reader, has no table.
 */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { LanguageRegistry, ROUTE_TABLE_MANIFESTS, type RouteTableSyntax } from "@kernel/language-id.ts";
import { MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile, walkRepoFiles, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import type { RouteTable } from "../../domain/route-table.ts";
import { loadRouteTable, type SourceReader } from "./route-table.loader.ts";

export interface RouteTables {
  syntax: RouteTableSyntax;
  head: RouteTable;
  base: RouteTable;
}

/* Directories that hold no route configuration of the app's own. */
const NOT_SOURCE_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "coverage", "out", "tmp", "vendor"]);
/* The most files of the working copy read to find the route configuration. */
export const MAX_ROUTE_SOURCE_FILES = 4000;
/* A file can hold a route table only when it names a path and one of the router's route keys. */
const MAY_HOLD_ROUTES = (source: string): boolean => /\bpath\s*:/.test(source) && /\b(loadChildren|loadComponent|component|redirectTo|children|canMatch|canActivate|matcher)\s*:/.test(source);

function headReader(mirrorDir: string): SourceReader {
  const root: SpecRoot = { mirrorDir, specDir: mirrorDir };
  return async (file) => {
    try {
      const read = readOwnedSpecFile(root, file, MAX_SPEC_SOURCE_BYTES);
      return "bytes" in read ? read.bytes.toString("utf8") : undefined;
    } catch {
      return undefined;
    }
  };
}

function dependenciesOf(manifest: string | undefined): Set<string> {
  if (manifest === undefined) return new Set();
  try {
    const parsed = JSON.parse(manifest) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = parsed[key];
      if (block !== null && typeof block === "object") for (const name of Object.keys(block)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

export interface RouteTablesInput {
  mirrorDir: string;
  /* The files the diff changed (added, modified, deleted), repository-relative. */
  changedFiles: readonly string[];
  /* One file as it was at the run's base, through the confined mirror reader; undefined when it did not exist there. */
  readAtBase: (file: string) => Promise<string | undefined>;
}

export async function routeTablesOf(input: RouteTablesInput): Promise<RouteTables | undefined> {
  const head = headReader(input.mirrorDir);
  let syntax: RouteTableSyntax | undefined;
  let dependencies = new Set<string>();
  for (const manifest of ROUTE_TABLE_MANIFESTS) {
    dependencies = dependenciesOf(await head(manifest));
    syntax = LanguageRegistry.routeTableSyntaxesFor({ file: manifest, dependencies })[0];
    if (syntax !== undefined) break;
  }
  if (syntax === undefined) return undefined;
  const reads = (file: string): boolean => LanguageRegistry.routeTableReads(syntax!, file) && !LanguageRegistry.isTestFile(file) && !file.endsWith(".d.ts");
  const walk = walkRepoFiles(input.mirrorDir, (_name, rel) => reads(rel), NOT_SOURCE_DIRS);
  if (walk.cut || walk.files.length > MAX_ROUTE_SOURCE_FILES) engineLog.warn(`[qa] route availability: the working copy holds more source files than the route-table search reads (${MAX_ROUTE_SOURCE_FILES}); routes declared past them are unexplained`);
  const holding: string[] = [];
  for (const file of walk.files.slice(0, MAX_ROUTE_SOURCE_FILES)) {
    const source = await head(file);
    if (source !== undefined && MAY_HOLD_ROUTES(source)) holding.push(file);
  }
  const changed = new Set(input.changedFiles);
  const base: SourceReader = (file) => (changed.has(file) ? input.readAtBase(file) : head(file));
  const baseHolding = new Set(holding);
  for (const file of changed) {
    if (!reads(file) || baseHolding.has(file)) continue;
    const source = await input.readAtBase(file);
    if (source !== undefined && MAY_HOLD_ROUTES(source)) baseHolding.add(file);
  }
  return {
    syntax,
    head: await loadRouteTable(syntax, holding, head, dependencies),
    base: await loadRouteTable(syntax, [...baseHolding], base, dependencies),
  };
}
