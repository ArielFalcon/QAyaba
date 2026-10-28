/*
 * The uses of a file the code graph could not link, completed with the language's own module resolution. The index records a
 * dynamic load (`import(…)`, `require(…)`, a `typeof import(…)` type) only by where it is, and an import whose specifier it could not follow (a `paths` alias
 * to a directory's index file) only by its specifier. Here a load whose specifier is a literal is read at its position and resolved
 * like an import: the file it names gains its loader as an importer, and a loader whose every load resolves (to a file or to an
 * installed package) no longer loads just anything. A computed specifier, one that resolves to nothing, or a loader that cannot be
 * read keeps it among the loaders that may load any file. An import the index could not link that resolves to an asked file
 * makes its importer a user of that file. Each specifier resolves from the nearest manifest's installed packages and the nearest
 * module configuration (`module-resolver.ts`); a file of a language with no module syntax resolves nothing. A list the index cut
 * keeps every loader as it is, or makes every file's uses a lower bound (`complete: false`).
 */
import { posix } from "node:path";
import { LanguageRegistry, type ModuleSyntax } from "@kernel/language-id.ts";
import type { ImportersReport } from "@kernel/code/index.ts";
import { loadedSpecifiersAt, type LoadPosition } from "./dynamic-loads.ts";
import { createModuleResolver, manifestDependencies, type ModuleResolution, type ModuleResolver, type SourceReader } from "./module-resolver.ts";

export interface UnlinkedUses {
  /* Where each dynamic load of a file that is not a test is. */
  dynamicLoads: { loads: Array<LoadPosition & { file: string }>; complete: boolean };
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

export async function withUnlinkedUses(report: ImportersReport, unlinked: UnlinkedUses, read: SourceReader): Promise<ImportersReport> {
  const asked = new Set(report.files.map((f) => f.file));
  const { resolve, importedFile } = resolvers(read);
  const found = new Map<string, Set<string>>();
  const use = (file: string, by: string): void => {
    if (asked.has(file) && file !== by) (found.get(file) ?? found.set(file, new Set()).get(file)!).add(by);
  };

  const loaders = new Set(report.dynamicLoaders.files);
  if (unlinked.dynamicLoads.complete) {
    const byLoader = new Map<string, LoadPosition[]>();
    for (const { file, line, col } of unlinked.dynamicLoads.loads) (byLoader.get(file) ?? byLoader.set(file, []).get(file)!).push({ line, col });
    for (const [loader, positions] of byLoader) {
      if (!loaders.has(loader)) continue;
      const source = await read(loader);
      if (source === undefined) continue;
      let every = true;
      for (const specifier of loadedSpecifiersAt(loader, source, positions)) {
        const resolution = specifier === undefined ? undefined : await resolve(loader, specifier);
        if (resolution !== undefined && "file" in resolution) use(resolution.file, loader);
        else if (resolution === undefined || !("external" in resolution)) every = false;
      }
      if (every) loaders.delete(loader);
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
