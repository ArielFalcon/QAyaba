/*
 * Builds an app's route table from its source files with the extractor the language registry declares for its framework: each
 * file read once, a module specifier resolved with the language's own module semantics (`module-resolver.ts`), what a path or a
 * guard names followed through re-exports and renames to the file and the name that declare it (a guard is placed only there,
 * never at a barrel), and a child table that is not inline (a lazily loaded module, a named array) attached under the entry that
 * loads it. A chain that does not come down to exactly one declaration leaves the item unresolved or unplaced. The reader decides
 * which commit the files are read at. Bounded, fail-open: what cannot be read is unresolved.
 */
import type { RouteTableSyntax } from "@kernel/language-id.ts";
import type { GuardRef, RouteEntry, RouteTable } from "../../domain/route-table.ts";
import { parseAngularRouteFile, type RawEntry, type RawRouteFile, type RawValue } from "./angular-router.extractor.ts";
import { createModuleResolver, type SourceReader } from "./module-resolver.ts";

export type { SourceReader } from "./module-resolver.ts";

const EXTRACTORS: Record<RouteTableSyntax, (file: string, source: string) => RawRouteFile | undefined> = {
  "angular-router": parseAngularRouteFile,
};

/* How deep child tables are followed; a deeper one is unresolved. */
const MAX_CHILD_DEPTH = 8;
/* How many re-exports one name is followed through; a longer chain is unresolved. */
const MAX_EXPORT_DEPTH = 12;

/* The declaration an exported name comes down to. */
interface Declaration {
  file: string;
  name: string;
}

export async function loadRouteTable(syntax: RouteTableSyntax, candidates: readonly string[], read: SourceReader, dependencies: ReadonlySet<string>): Promise<RouteTable> {
  const extract = EXTRACTORS[syntax];
  const resolver = createModuleResolver(syntax, read, dependencies);
  const parsed = new Map<string, Promise<RawRouteFile | undefined>>();
  const parse = (file: string): Promise<RawRouteFile | undefined> => {
    let held = parsed.get(file);
    if (held === undefined) {
      held = read(file).then((source) => (source === undefined ? undefined : extract(file, source)));
      parsed.set(file, held);
    }
    return held;
  };
  const fileOf = async (from: string, specifier: string): Promise<string | undefined> => {
    const resolution = await resolver.resolve(from, specifier);
    return "file" in resolution ? resolution.file : undefined;
  };
  /* The one declaration `name` exported by `file` comes down to, following renames, `export { x } from`, `export *` and re-exported imports; undefined when the chain ends nowhere, loops, or reaches two declarations. */
  const declarationOf = async (file: string, name: string, trail: ReadonlySet<string> = new Set()): Promise<Declaration | undefined> => {
    const key = `${file}\0${name}`;
    if (trail.has(key) || trail.size >= MAX_EXPORT_DEPTH) return undefined;
    const raw = await parse(file);
    if (raw === undefined) return undefined;
    const next = new Set(trail).add(key);
    const explicit = raw.exports.get(name);
    if (explicit !== undefined) {
      if ("module" in explicit) {
        const target = await fileOf(file, explicit.module);
        return target === undefined ? undefined : declarationOf(target, explicit.imported, next);
      }
      if (raw.declared.has(explicit.local)) return { file, name: explicit.local };
      const imported = raw.imports.get(explicit.local);
      const target = imported === undefined ? undefined : await fileOf(file, imported.module);
      return imported === undefined || target === undefined ? undefined : declarationOf(target, imported.imported, next);
    }
    /* An explicit export wins over `export *`, which never re-exports a default. */
    if (name === "default") return undefined;
    const found = new Map<string, Declaration>();
    for (const star of raw.stars) {
      const target = await fileOf(file, star);
      const declaration = target === undefined ? undefined : await declarationOf(target, name, next);
      if (declaration !== undefined) found.set(`${declaration.file}\0${declaration.name}`, declaration);
    }
    return found.size === 1 ? [...found.values()][0] : undefined;
  };
  const valueOf = async (file: string, raw: RawRouteFile, value: RawValue | undefined): Promise<string | undefined> => {
    if (value === undefined || "opaque" in value) return undefined;
    if ("literal" in value) return value.literal;
    if (value.module === undefined || value.imported === undefined) return raw.constants.get(value.member === undefined ? value.ref : `${value.ref}.${value.member}`);
    const target = await fileOf(file, value.module);
    if (target === undefined) return undefined;
    /* A namespace import names the module itself: its member is a top-level constant of that file. */
    if (value.imported === "*") return value.member === undefined ? undefined : (await parse(target))?.constants.get(value.member);
    const declaration = await declarationOf(target, value.imported);
    const declaring = declaration === undefined ? undefined : await parse(declaration.file);
    return declaration === undefined ? undefined : declaring?.constants.get(value.member === undefined ? declaration.name : `${declaration.name}.${value.member}`);
  };
  const guardOf = async (file: string, guard: RawEntry["guards"][number]): Promise<GuardRef> => {
    if ("inline" in guard) return { name: "(inline)" };
    if (guard.local) return { name: guard.name, file };
    if (guard.module === undefined) return { name: guard.name };
    const resolution = await resolver.resolve(file, guard.module);
    if ("external" in resolution) return { name: guard.name, external: true };
    if (!("file" in resolution)) return { name: guard.name };
    /* Placed only at the file that declares what the import takes: a barrel that re-exports it is not where it lives. */
    const declaration = await declarationOf(resolution.file, guard.name);
    return declaration === undefined ? { name: guard.name } : { name: declaration.name, file: declaration.file };
  };
  /* The tables other files load as children, so that they are not roots: `file\0name`. */
  const referenced = new Set<string>();
  const tableOf = (raw: RawRouteFile, name: string | undefined): RawRouteFile["tables"][number] | undefined =>
    name !== undefined && name !== "default" ? raw.tables.find((t) => t.name === name) : raw.tables.find((t) => t.exported) ?? raw.tables[0];
  /* The file and the table a child reference comes down to. */
  const childTableOf = async (file: string, raw: RawRouteFile, ref: NonNullable<RawEntry["childRef"]>): Promise<{ file: string; raw: RawRouteFile; table: RawRouteFile["tables"][number] } | undefined> => {
    if (ref.unresolved) return undefined;
    if (ref.module === undefined) {
      const table = tableOf(raw, ref.name);
      return table === undefined ? undefined : { file, raw, table };
    }
    const target = await fileOf(file, ref.module);
    if (target === undefined) return undefined;
    const named = ref.name !== undefined && ref.name !== "default";
    const declaration = named ? await declarationOf(target, ref.name!) : { file: target, name: "default" };
    const declaring = declaration === undefined ? undefined : await parse(declaration.file);
    const table = declaring === undefined ? undefined : tableOf(declaring, named ? declaration!.name : undefined);
    return declaration === undefined || declaring === undefined || table === undefined ? undefined : { file: declaration.file, raw: declaring, table };
  };
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
        const child = depth >= MAX_CHILD_DEPTH ? undefined : await childTableOf(file, raw, entry.childRef);
        if (child !== undefined) {
          referenced.add(`${child.file}\0${child.table.name}`);
          built.lazy = { children: await build(child.file, child.raw, child.table.entries, depth + 1) };
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
