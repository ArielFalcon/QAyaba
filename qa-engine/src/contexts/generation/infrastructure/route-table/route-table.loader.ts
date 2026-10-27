/*
 * Builds an app's route table from its source files with the extractor the language registry declares for its framework: each
 * file read once, a module specifier resolved with the language's own module semantics (`module-resolver.ts`), what a path or a
 * guard names followed through re-exports and renames to the file and the name that declare it (a guard is placed only there,
 * never at a barrel), and a child table that is not inline (a lazily loaded module, a named array) attached under the entry that
 * loads it. A chain that does not come down to exactly one declaration leaves the item unresolved or unplaced, and the entry
 * records which link it could not follow and why. The reader decides which commit the files are read at. Bounded, fail-open:
 * what cannot be read is unresolved.
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

/* What a lookup found, or why it found nothing. */
type Found<T> = { found: T } | { why: string };

type ChildTable = { file: string; raw: RawRouteFile; table: RawRouteFile["tables"][number] };

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
  const fileOf = async (from: string, specifier: string): Promise<Found<string>> => {
    const resolution = await resolver.resolve(from, specifier);
    if ("file" in resolution) return { found: resolution.file };
    return { why: "external" in resolution ? `${specifier} is an installed package, which declares none of the app's own names` : resolution.unresolved };
  };
  /* The one declaration `name` exported by `file` comes down to, following renames, `export { x } from`, `export *` and re-exported imports; why not when the chain ends nowhere, loops, or reaches two declarations. */
  const declarationOf = async (file: string, name: string, trail: ReadonlySet<string> = new Set()): Promise<Found<Declaration>> => {
    const key = `${file}\0${name}`;
    if (trail.has(key) || trail.size >= MAX_EXPORT_DEPTH) return { why: `the exports of ${file} loop or run deeper than ${MAX_EXPORT_DEPTH} re-exports` };
    const raw = await parse(file);
    if (raw === undefined) return { why: `${file} could not be read` };
    const next = new Set(trail).add(key);
    const explicit = raw.exports.get(name);
    if (explicit !== undefined) {
      if ("module" in explicit) {
        const target = await fileOf(file, explicit.module);
        return "found" in target ? declarationOf(target.found, explicit.imported, next) : target;
      }
      if (raw.declared.has(explicit.local)) return { found: { file, name: explicit.local } };
      const imported = raw.imports.get(explicit.local);
      if (imported === undefined) return { why: `${file} exports ${explicit.local}, which it does not declare` };
      const target = await fileOf(file, imported.module);
      return "found" in target ? declarationOf(target.found, imported.imported, next) : target;
    }
    /* An explicit export wins over `export *`, which never re-exports a default. */
    if (name === "default") return { why: `${file} has no default export` };
    const found = new Map<string, Declaration>();
    const reasons: string[] = [];
    for (const star of raw.stars) {
      const target = await fileOf(file, star);
      if (!("found" in target)) {
        reasons.push(target.why);
        continue;
      }
      const declaration = await declarationOf(target.found, name, next);
      if ("found" in declaration) found.set(`${declaration.found.file}\0${declaration.found.name}`, declaration.found);
    }
    if (found.size === 1) return { found: [...found.values()][0]! };
    if (found.size > 1) return { why: `${name} is declared by more than one module ${file} re-exports` };
    return { why: reasons.length > 0 ? `${name} is not exported by ${file} (${reasons.join("; ")})` : `${name} is not exported by ${file}` };
  };
  const valueOf = async (file: string, raw: RawRouteFile, value: RawValue | undefined): Promise<Found<string> | undefined> => {
    if (value === undefined) return undefined;
    if ("opaque" in value) return { why: "it is neither a literal nor the name of a constant" };
    if ("literal" in value) return { found: value.literal };
    const key = value.member === undefined ? value.ref : `${value.ref}.${value.member}`;
    const noValue = { why: `${key} holds no string value` };
    if (value.module === undefined || value.imported === undefined) {
      const own = raw.constants.get(key);
      return own === undefined ? noValue : { found: own };
    }
    const target = await fileOf(file, value.module);
    if (!("found" in target)) return target;
    /* A namespace import names the module itself: its member is a top-level constant of that file. */
    if (value.imported === "*") {
      const namespaced = value.member === undefined ? undefined : (await parse(target.found))?.constants.get(value.member);
      return namespaced === undefined ? noValue : { found: namespaced };
    }
    const declaration = await declarationOf(target.found, value.imported);
    if (!("found" in declaration)) return declaration;
    const declaring = await parse(declaration.found.file);
    const text = declaring?.constants.get(value.member === undefined ? declaration.found.name : `${declaration.found.name}.${value.member}`);
    return text === undefined ? noValue : { found: text };
  };
  const guardOf = async (file: string, guard: RawEntry["guards"][number]): Promise<{ ref: GuardRef; why?: string }> => {
    if ("inline" in guard) return { ref: { name: "(inline)" } };
    if (guard.local) return { ref: { name: guard.name, file } };
    if (guard.module === undefined) return { ref: { name: guard.name }, why: `${guard.name} is neither declared in this file nor imported` };
    const resolution = await resolver.resolve(file, guard.module);
    if ("external" in resolution) return { ref: { name: guard.name, external: true } };
    if (!("file" in resolution)) return { ref: { name: guard.name }, why: resolution.unresolved };
    /* Placed only at the file that declares what the import takes: a barrel that re-exports it is not where it lives. */
    const declaration = await declarationOf(resolution.file, guard.name);
    return "found" in declaration ? { ref: { name: declaration.found.name, file: declaration.found.file } } : { ref: { name: guard.name }, why: declaration.why };
  };
  /* The tables other files load as children, so that they are not roots: `file\0name`. */
  const referenced = new Set<string>();
  const tableOf = (raw: RawRouteFile, name: string | undefined): RawRouteFile["tables"][number] | undefined =>
    name !== undefined && name !== "default" ? raw.tables.find((t) => t.name === name) : raw.tables.find((t) => t.exported) ?? raw.tables[0];
  /* The file and the table a child reference comes down to. */
  const childTableOf = async (file: string, raw: RawRouteFile, ref: NonNullable<RawEntry["childRef"]>): Promise<Found<ChildTable>> => {
    if (ref.unresolved) return { why: ref.why ?? "it names no table" };
    if (ref.module === undefined) {
      const table = tableOf(raw, ref.name);
      return table === undefined ? { why: `${file} holds no route table named ${ref.name ?? "(any)"}` } : { found: { file, raw, table } };
    }
    const target = await fileOf(file, ref.module);
    if (!("found" in target)) return target;
    const named = ref.name !== undefined && ref.name !== "default";
    const declaration: Found<Declaration> = named ? await declarationOf(target.found, ref.name!) : { found: { file: target.found, name: "default" } };
    if (!("found" in declaration)) return declaration;
    const declaring = await parse(declaration.found.file);
    const table = declaring === undefined ? undefined : tableOf(declaring, named ? declaration.found.name : undefined);
    if (declaring === undefined || table === undefined) return { why: `${declaration.found.file} holds no route table named ${named ? declaration.found.name : "(default)"}` };
    return { found: { file: declaration.found.file, raw: declaring, table } };
  };
  const build = async (file: string, raw: RawRouteFile, entries: readonly RawEntry[], depth: number): Promise<RouteEntry[]> => {
    const out: RouteEntry[] = [];
    for (const entry of entries) {
      const at = `${file}:${entry.line}`;
      const unresolved: string[] = [];
      const path = await valueOf(file, raw, entry.path);
      if (path !== undefined && "why" in path) unresolved.push(`${at} path ${entry.path !== undefined && "ref" in entry.path ? (entry.path.member === undefined ? entry.path.ref : `${entry.path.ref}.${entry.path.member}`) : "expression"}: ${path.why}`);
      const guards = await Promise.all(entry.guards.map((guard) => guardOf(file, guard)));
      for (const guard of guards) if (guard.why !== undefined) unresolved.push(`${at} guard ${guard.ref.name} is unplaced: ${guard.why}`);
      const text = path !== undefined && "found" in path ? path.found : undefined;
      const built: RouteEntry = {
        file,
        line: entry.line,
        endLine: entry.endLine,
        ...(text !== undefined ? { path: text } : {}),
        pathMatchFull: entry.pathMatchFull,
        matcher: entry.matcher,
        redirect: entry.redirect,
        signature: `${text ?? "?"}|${entry.ownText}`,
        guards: guards.map((guard) => guard.ref),
      };
      if (entry.children !== undefined) built.children = await build(file, raw, entry.children, depth + 1);
      if (entry.childRef !== undefined) {
        const child: Found<ChildTable> = depth >= MAX_CHILD_DEPTH ? { why: `the tables nest deeper than ${MAX_CHILD_DEPTH} levels` } : await childTableOf(file, raw, entry.childRef);
        if ("found" in child) {
          referenced.add(`${child.found.file}\0${child.found.table.name}`);
          built.lazy = { children: await build(child.found.file, child.found.raw, child.found.table.entries, depth + 1) };
        } else {
          built.lazy = { unresolved: true };
          unresolved.push(`${at} loadChildren: ${child.why}`);
        }
      }
      if (unresolved.length > 0) built.unresolved = unresolved;
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
