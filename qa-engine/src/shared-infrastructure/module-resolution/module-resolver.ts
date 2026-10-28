/*
 * Which file a module specifier names, from the file that imports it, with the language's own module semantics (the module syntax
 * the language registry declares): a relative specifier as written, with each extension of the syntax's languages, or its index
 * file; any other through the nearest module configuration the registry declares for the syntax (tsconfig's `paths`, `baseUrl`
 * and `extends` chain), resolved by the TypeScript compiler's resolver. Shared by every reader that follows a specifier: the route
 * table, and the code graph's uses of a file the index could not link. The compiler's host is synchronous and the readers are not (the working copy
 * through the confined reader at head, the mirror at the base), so a resolution runs again over the files it asked for until it
 * asks for no more; a file the reader cannot give is absent. A specifier no configuration resolves is external when it names a
 * dependency of the manifest, and otherwise unresolved with the reason. Never builds a program, never reads a file the
 * resolution does not ask for.
 */
import { posix } from "node:path";
import ts from "typescript";
import { LanguageRegistry, type ModuleSyntax } from "@kernel/language-id.ts";

export type SourceReader = (file: string) => Promise<string | undefined>;

export type ModuleResolution = { file: string } | { external: true } | { unresolved: string };

export interface ModuleResolver {
  resolve(from: string, specifier: string): Promise<ModuleResolution>;
  /* The module configuration that governs a file (the nearest one up from its directory), or undefined when none does. */
  governingConfig(from: string): Promise<string | undefined>;
}

/* How many times one resolution runs again over the files the previous run asked for; a resolution still asking after them is unresolved. */
const MAX_RESOLUTION_ROUNDS = 6;

/* The package an import specifier names (`@scope/name` or `name`), or undefined for a relative one. */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/* The packages a manifest declares (its dependencies, dev and peer dependencies); none when it cannot be read or parsed. */
export function manifestDependencies(manifest: string | undefined): Set<string> {
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

export function createModuleResolver(syntax: ModuleSyntax, read: SourceReader, dependencies: ReadonlySet<string>): ModuleResolver {
  const extensions = LanguageRegistry.extensions.filter((ext) => LanguageRegistry.moduleSyntaxForFile(`x.${ext}`) === syntax);
  const configNames = LanguageRegistry.moduleConfigs(syntax);
  const reads = (file: string): boolean => LanguageRegistry.moduleSyntaxForFile(file) === syntax && !file.endsWith(".d.ts");

  const exists = new Map<string, Promise<boolean>>();
  const present = (file: string): Promise<boolean> => {
    let held = exists.get(file);
    if (held === undefined) {
      held = read(file).then((source) => source !== undefined);
      exists.set(file, held);
    }
    return held;
  };
  const relative = async (from: string, specifier: string): Promise<ModuleResolution> => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (base.startsWith("..")) return { unresolved: `${specifier} leaves the repository` };
    const tried = [base, ...extensions.map((ext) => `${base}.${ext}`), ...extensions.map((ext) => `${base}/index.${ext}`)];
    for (const file of tried) if (reads(file) && (await present(file))) return { file };
    return { unresolved: `${specifier} names no file` };
  };

  /* What the compiler's synchronous host knows of the files: `undefined` is a file the reader gave nothing for. Only text of JSON files (configurations) is kept. */
  const known = new Map<string, string | undefined>();
  const absolute = (file: string): string => `/${file}`;
  const settle = async <T>(run: (host: ts.ModuleResolutionHost & ts.ParseConfigHost) => T): Promise<T | undefined> => {
    for (let round = 0; round < MAX_RESOLUTION_ROUNDS; round++) {
      const asked = new Set<string>();
      const lookup = (path: string): string | undefined => {
        if (!known.has(path)) asked.add(path);
        return known.get(path);
      };
      const result = run({
        fileExists: (path) => lookup(path) !== undefined,
        readFile: (path) => lookup(path),
        readDirectory: () => [],
        directoryExists: undefined,
        getCurrentDirectory: () => "/",
        useCaseSensitiveFileNames: true,
      });
      if (asked.size === 0) return result;
      await Promise.all(
        [...asked].map(async (path) => {
          const text = path.startsWith("/..") ? undefined : await read(path.slice(1));
          known.set(path, text === undefined ? undefined : path.endsWith(".json") ? text : "");
        }),
      );
    }
    return undefined;
  };

  /* The nearest module configuration up from a file's directory, parsed with its `extends` chain; undefined when none governs the file. */
  const configs = new Map<string, Promise<{ file: string; options: ts.CompilerOptions } | undefined>>();
  const configOf = (dir: string): Promise<{ file: string; options: ts.CompilerOptions } | undefined> => {
    let held = configs.get(dir);
    if (held === undefined) {
      held = (async () => {
        for (const name of configNames) {
          const file = dir === "." ? name : `${dir}/${name}`;
          const text = await read(file);
          if (text === undefined) continue;
          const json = ts.parseConfigFileTextToJson(absolute(file), text);
          if (json.error !== undefined || json.config === undefined) return undefined;
          const options = await settle((host) => ts.parseJsonConfigFileContent(json.config, host, absolute(dir === "." ? "" : dir) || "/", undefined, absolute(file)).options);
          return options === undefined ? undefined : { file, options };
        }
        return dir === "." ? undefined : configOf(posix.dirname(dir));
      })();
      configs.set(dir, held);
    }
    return held;
  };

  const aliased = async (from: string, specifier: string): Promise<ModuleResolution> => {
    const pkg = packageOf(specifier);
    const external = pkg !== undefined && dependencies.has(pkg);
    const config = await configOf(posix.dirname(from));
    if (config === undefined) return external ? { external: true } : { unresolved: `${specifier} is not relative and no module configuration governs ${from}` };
    const { options } = config;
    /* An installed package no `paths` or `baseUrl` of the configuration could name. */
    if (external && options.paths === undefined && options.baseUrl === undefined) return { external: true };
    const resolved = await settle((host) =>
      ts.resolveModuleName(specifier, absolute(from), { ...options, allowJs: true, moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.Bundler }, host).resolvedModule,
    );
    if (resolved === undefined) return external ? { external: true } : { unresolved: `${specifier} matches no \`paths\` or \`baseUrl\` entry of ${config.file}` };
    if (resolved.isExternalLibraryImport === true) return { external: true };
    const file = resolved.resolvedFileName.replace(/^\//, "");
    return reads(file) ? { file } : { unresolved: `${specifier} resolves to ${file}, which is no source of the module syntax` };
  };

  return {
    resolve: (from, specifier) => (specifier.startsWith(".") ? relative(from, specifier) : specifier.startsWith("/") ? Promise.resolve({ unresolved: `${specifier} is an absolute path` }) : aliased(from, specifier)),
    governingConfig: async (from) => (await configOf(posix.dirname(from)))?.file,
  };
}
