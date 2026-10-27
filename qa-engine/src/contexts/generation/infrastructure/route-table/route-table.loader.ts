/*
 * Builds an app's route table from its source files with the extractor the language registry declares for its framework: each
 * file read once, the string constants a path names resolved through the file that declares them, a guard placed at the file that
 * declares the export it imports (never at a file that only re-exports it), and a child table that is not inline (a lazily loaded module, a named array) attached under the entry that loads
 * it. Relative modules only: a module of an installed package is external, any other (an alias the extractor cannot follow) is
 * left unplaced. The reader decides which commit the files are read at. Bounded, fail-open: what cannot be read is unresolved.
 */
import { posix } from "node:path";
import { LanguageRegistry, type RouteTableSyntax } from "@kernel/language-id.ts";
import type { GuardRef, RouteEntry, RouteTable } from "../../domain/route-table.ts";
import { parseAngularRouteFile, type RawEntry, type RawRouteFile, type RawValue } from "./angular-router.extractor.ts";

export type SourceReader = (file: string) => Promise<string | undefined>;

const EXTRACTORS: Record<RouteTableSyntax, (file: string, source: string) => RawRouteFile | undefined> = {
  "angular-router": parseAngularRouteFile,
};

/* How deep child tables are followed; a deeper one is unresolved. */
const MAX_CHILD_DEPTH = 8;

/* The package an import specifier names (`@scope/name` or `name`), or undefined for a relative one. */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export async function loadRouteTable(syntax: RouteTableSyntax, candidates: readonly string[], read: SourceReader, dependencies: ReadonlySet<string>): Promise<RouteTable> {
  const extract = EXTRACTORS[syntax];
  const extensions = LanguageRegistry.extensions.filter((ext) => LanguageRegistry.routeTableReads(syntax, `x.${ext}`));
  const parsed = new Map<string, Promise<RawRouteFile | undefined>>();
  const parse = (file: string): Promise<RawRouteFile | undefined> => {
    let held = parsed.get(file);
    if (held === undefined) {
      held = read(file).then((source) => (source === undefined ? undefined : extract(file, source)));
      parsed.set(file, held);
    }
    return held;
  };
  const exists = new Map<string, Promise<boolean>>();
  const present = (file: string): Promise<boolean> => {
    let held = exists.get(file);
    if (held === undefined) {
      held = read(file).then((source) => source !== undefined);
      exists.set(file, held);
    }
    return held;
  };
  /* The file a relative module names: as written, with each extension of the syntax's languages, or its index file. */
  const moduleFile = async (from: string, specifier: string): Promise<string | undefined> => {
    if (!specifier.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (base.startsWith("..")) return undefined;
    const tried = [base, ...extensions.map((ext) => `${base}.${ext}`), ...extensions.map((ext) => `${base}/index.${ext}`)];
    for (const file of tried) if (LanguageRegistry.routeTableReads(syntax, file) && (await present(file))) return file;
    return undefined;
  };
  const valueOf = async (file: string, raw: RawRouteFile, value: RawValue | undefined): Promise<string | undefined> => {
    if (value === undefined || "opaque" in value) return undefined;
    if ("literal" in value) return value.literal;
    const key = value.member === undefined ? value.ref : `${value.ref}.${value.member}`;
    if (value.module === undefined) return raw.constants.get(key);
    const target = await moduleFile(file, value.module);
    const declaring = target === undefined ? undefined : await parse(target);
    return declaring?.constants.get(key);
  };
  const guardOf = async (file: string, guard: RawEntry["guards"][number]): Promise<GuardRef> => {
    if ("inline" in guard) return { name: "(inline)" };
    if (guard.local) return { name: guard.name, file };
    if (guard.module === undefined) return { name: guard.name };
    const pkg = packageOf(guard.module);
    if (pkg !== undefined) return dependencies.has(pkg) ? { name: guard.name, external: true } : { name: guard.name };
    const target = await moduleFile(file, guard.module);
    if (target === undefined) return { name: guard.name };
    /* Placed only at a file that declares the export the import takes: a barrel that re-exports it is not where it lives. */
    const declaring = await parse(target);
    const name = guard.name === "default" ? declaring?.defaultExport : guard.name;
    return name !== undefined && declaring?.declared.has(name) === true ? { name, file: target } : { name: guard.name };
  };
  /* The tables other files load as children, so that they are not roots: `file\0name`. */
  const referenced = new Set<string>();
  const tableOf = (raw: RawRouteFile, name: string | undefined): RawRouteFile["tables"][number] | undefined =>
    name !== undefined && name !== "default" ? raw.tables.find((t) => t.name === name) : raw.tables.find((t) => t.exported) ?? raw.tables[0];
  const build = async (file: string, raw: RawRouteFile, entries: readonly RawEntry[], depth: number): Promise<RouteEntry[]> => {
    const out: RouteEntry[] = [];
    for (const entry of entries) {
      const path = await valueOf(file, raw, entry.path);
      const guards = await Promise.all(entry.guards.map((guard) => guardOf(file, guard)));
      const built: RouteEntry = {
        file,
        line: entry.line,
        endLine: entry.endLine,
        ...(path !== undefined ? { path } : {}),
        pathMatchFull: entry.pathMatchFull,
        matcher: entry.matcher,
        redirect: entry.redirect,
        signature: `${path ?? "?"}|${entry.ownText}`,
        guards,
      };
      if (entry.children !== undefined) built.children = await build(file, raw, entry.children, depth + 1);
      if (entry.childRef !== undefined) {
        const ref = entry.childRef;
        const target = ref.unresolved ? undefined : ref.module === undefined ? file : await moduleFile(file, ref.module);
        const targetRaw = target === undefined || depth >= MAX_CHILD_DEPTH ? undefined : target === file ? raw : await parse(target);
        const table = targetRaw === undefined ? undefined : tableOf(targetRaw, ref.name);
        if (target !== undefined && table !== undefined) {
          referenced.add(`${target}\0${table.name}`);
          built.lazy = { children: await build(target, targetRaw!, table.entries, depth + 1) };
        } else {
          built.lazy = { unresolved: true };
        }
      }
      out.push(built);
    }
    return out;
  };
  const built: Array<{ file: string; name: string; entries: RouteEntry[] }> = [];
  for (const file of [...candidates].sort()) {
    const raw = await parse(file);
    if (raw === undefined) continue;
    for (const table of raw.tables) built.push({ file, name: table.name, entries: await build(file, raw, table.entries, 0) });
  }
  return { roots: built.filter((t) => !referenced.has(`${t.file}\0${t.name}`)).map((t) => t.entries) };
}
