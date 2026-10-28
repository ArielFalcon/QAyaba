/*
 * The uses of a file the code graph could not link, completed with the language's own module resolution. The index records a
 * dynamic load only by where it is, and not every form of one (`import.meta.glob` not at all), and an import whose specifier it
 * could not follow (a `paths` alias to a directory's index file) only by its specifier. Here every source that is not a test, of a
 * language with a module syntax, is read whole through the given reader (`dynamic-loads.ts`; one not in the working copy loads nothing unless the index saw it load): a load of a literal specifier that
 * resolves to a file makes the file it names gain its loader as an importer, one that resolves to an installed package names no
 * file of the app, and a type that names a module (`typeof import('…')`) is a use of the file it resolves to. A source that cannot
 * be read or parsed, a load it does not name by a literal (a computed specifier, `require.context`, `import.meta.glob`), or a
 * literal that resolves to nothing makes it a loader that may load any file; one whose every load resolves is none, whatever the
 * index listed. The index's loaders of a language with no module syntax stay as they are. An import the index could not link that
 * resolves to an asked file makes its importer a user of that file. Each specifier resolves from the nearest manifest's installed
 * packages and the nearest module configuration (`module-resolver.ts`). A list the index cut keeps every loader as it is, or
 * makes every file's uses a lower bound (`complete: false`).
 */
import { posix } from "node:path";
import { LanguageRegistry, type ModuleSyntax } from "@kernel/language-id.ts";
import type { ImportersReport } from "@kernel/code/index.ts";
import { moduleLoadsOf } from "./dynamic-loads.ts";
import { createModuleResolver, manifestDependencies, type ModuleResolution, type ModuleResolver, type SourceReader } from "./module-resolver.ts";

/* A source as the scan reads it: its text, not there (no code of this working copy), or there and unreadable (refused, over its cap). */
export type ScannedSource = { text: string } | "absent" | "unreadable";

export interface UnlinkedUses {
  /* The specifiers the code of a file that is not a test imports and the index could not link. */
  unresolvedImports: { imports: Array<{ file: string; specifier: string }>; complete: boolean };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Resolvers {
  /* How a specifier written in `from` resolves, or undefined for a file of a language with no module syntax. */
  resolve(from: string, specifier: string): Promise<ModuleResolution | undefined>;
  /*
   * The file of the repository an import written in `from` names, or undefined. A specifier that is not relative names the same
   * file from every directory one module configuration governs (`paths` and `baseUrl` do not depend on the importing directory,
   * and what only a `node_modules` lookup finds is an installed package), so it is resolved once per configuration.
   */
  importedFile(from: string, specifier: string): Promise<string | undefined>;
}

/* One resolver per module syntax and nearest manifest, each specifier resolved once per importing directory. */
function resolvers(read: SourceReader): Resolvers {
  const manifests = new Map<string, Promise<string | undefined>>();
  const nearestManifest = (dir: string, name: string): Promise<string | undefined> => {
    const key = `${name}\0${dir}`;
    let held = manifests.get(key);
    if (held === undefined) {
      held = (async () => {
        const file = dir === "." ? name : `${dir}/${name}`;
        if ((await read(file)) !== undefined) return file;
        return dir === "." ? undefined : nearestManifest(posix.dirname(dir), name);
      })();
      manifests.set(key, held);
    }
    return held;
  };
  const byManifest = new Map<string, Promise<ModuleResolver>>();
  const resolverOf = async (syntax: ModuleSyntax, dir: string): Promise<ModuleResolver> => {
    const manifest = (await nearestManifest(dir, LanguageRegistry.moduleManifest(syntax))) ?? "";
    const key = `${syntax}\0${manifest}`;
    let resolver = byManifest.get(key);
    if (resolver === undefined) {
      resolver = (async () => createModuleResolver(syntax, read, manifestDependencies(manifest === "" ? undefined : await read(manifest))))();
      byManifest.set(key, resolver);
    }
    return resolver;
  };
  const resolved = new Map<string, Promise<ModuleResolution>>();
  const once = (key: string, run: () => Promise<ModuleResolution>): Promise<ModuleResolution> => {
    let held = resolved.get(key);
    if (held === undefined) {
      held = run();
      resolved.set(key, held);
    }
    return held;
  };
  const resolve = async (from: string, specifier: string): Promise<ModuleResolution | undefined> => {
    const syntax = LanguageRegistry.moduleSyntaxForFile(from);
    if (syntax === null) return undefined;
    const dir = posix.dirname(from);
    return once(`${syntax}\0dir\0${dir}\0${specifier}`, async () => (await resolverOf(syntax, dir)).resolve(from, specifier));
  };
  const importedFile = async (from: string, specifier: string): Promise<string | undefined> => {
    const syntax = LanguageRegistry.moduleSyntaxForFile(from);
    if (syntax === null) return undefined;
    if (specifier.startsWith(".")) {
      const resolution = await resolve(from, specifier);
      return resolution !== undefined && "file" in resolution ? resolution.file : undefined;
    }
    const resolver = await resolverOf(syntax, posix.dirname(from));
    const config = await resolver.governingConfig(from);
    if (config === undefined) return undefined;
    const resolution = await once(`${syntax}\0config\0${config}\0${specifier}`, () => resolver.resolve(from, specifier));
    return "file" in resolution ? resolution.file : undefined;
  };
  return { resolve, importedFile };
}

/* `sources`: the files of the repository the index holds; those that are tests, or of a language with no module syntax, are not read. */
/* `read` gives a file's text, for resolution (one not given is absent); `scan` reads a source whole, telling a file that is not there from one that cannot be read. */
export async function withUnlinkedUses(report: ImportersReport, unlinked: UnlinkedUses, sources: readonly string[], read: SourceReader, scan: (file: string) => Promise<ScannedSource>): Promise<ImportersReport> {
  const asked = new Set(report.files.map((f) => f.file));
  const { resolve, importedFile } = resolvers(read);
  const found = new Map<string, Set<string>>();
  const use = (file: string, by: string): void => {
    if (asked.has(file) && file !== by) (found.get(file) ?? found.set(file, new Set()).get(file)!).add(by);
  };

  /* A source that is not a test, of a language with a module syntax, is read whole: what it loads decides whether it is a loader. */
  const listed = new Set(report.dynamicLoaders.files);
  const loaders = new Set(report.dynamicLoaders.files.filter((file) => LanguageRegistry.moduleSyntaxForFile(file) === null || LanguageRegistry.isTestFile(file)));
  const scanned = [...new Set([...sources, ...report.dynamicLoaders.files])].filter((file) => LanguageRegistry.moduleSyntaxForFile(file) !== null && !LanguageRegistry.isTestFile(file));
  for (const file of scanned.sort(compare)) {
    const source = await scan(file);
    /* A file not in the working copy is no code of it, unless the index saw it load modules: then nothing proves what it loads. */
    if (source === "absent") {
      if (listed.has(file)) loaders.add(file);
      continue;
    }
    const loads = source === "unreadable" ? undefined : moduleLoadsOf(file, source.text);
    /* A file the index saw load modules, in which the reading finds no load at all, loads by a form the reading does not know. */
    if (loads === undefined || loads.opaque || (listed.has(file) && loads.loads.length === 0 && loads.types.length === 0)) {
      loaders.add(file);
      continue;
    }
    for (const specifier of loads.loads) {
      const resolution = await resolve(file, specifier);
      if (resolution !== undefined && "file" in resolution) use(resolution.file, file);
      else if (resolution === undefined || !("external" in resolution)) loaders.add(file);
    }
    for (const specifier of loads.types) {
      const target = await importedFile(file, specifier);
      if (target !== undefined) use(target, file);
    }
  }

  for (const { file, specifier } of unlinked.unresolvedImports.imports) {
    const target = await importedFile(file, specifier);
    if (target !== undefined) use(target, file);
  }

  const merged = (list: readonly string[], extra: ReadonlySet<string> | undefined): string[] => (extra === undefined ? [...list] : [...new Set([...list, ...extra])].sort(compare));
  return {
    ...report,
    files: report.files.map((f) => ({
      ...f,
      importers: merged(f.importers, found.get(f.file)),
      users: merged(f.users, found.get(f.file)),
      complete: f.complete && unlinked.unresolvedImports.complete,
    })),
    dynamicLoaders: { files: [...loaders].sort(compare), complete: report.dynamicLoaders.complete },
  };
}
