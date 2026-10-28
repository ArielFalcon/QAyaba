/* Single language registry for every extractor in this context. `supported` and `hasAstGrepRules` both derive from LANGS — adding a language is one record. Project-agnostic: keyed by language, never by app. */
export type LanguageId = "javascript" | "typescript" | "java";

/* JavaScript and TypeScript share their test conventions: a `.test.` or `.spec.` file, or a file under `__tests__/`. */
const JS_TEST_PATHS: readonly RegExp[] = [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//];

/*
 * astGrep: true → AstGrepPatternAdapter; false → regex fallback. Both `supported` and `hasAstGrepRules` derive from this record.
 * testPaths: the language's own conventions for a test file (the build tool's test source set, the test-runner's file names).
 */
const JS_MANIFESTS: readonly string[] = ["package.json", "tsconfig.json", "jsconfig.json"];

/*
 * manifests: the build files whose presence names the language's stack and frameworks (a code-graph engine reads them to
 * recognise one), by file name.
 * decisions: the syntax the static decision listing reads the language's source with, or null when the language has no lister
 * (its changed decisions are not listed, never guessed).
 * statements: the syntax that tells which of a source's statements are no executable code (an import, a re-export, a type-only
 * declaration), or null when the language declares none (every non-blank line of its source is then taken for code).
 */
export type DecisionSyntax = "ecmascript";
export type StatementSyntax = "ecmascript";

const LANGS: Record<LanguageId, { astGrep: boolean; testPaths: readonly RegExp[]; manifests: readonly string[]; decisions: DecisionSyntax | null; statements: StatementSyntax | null }> = {
  javascript: { astGrep: true, testPaths: JS_TEST_PATHS, manifests: JS_MANIFESTS, decisions: "ecmascript", statements: "ecmascript" },
  typescript: { astGrep: true, testPaths: JS_TEST_PATHS, manifests: JS_MANIFESTS, decisions: "ecmascript", statements: "ecmascript" },
  java:       { astGrep: true, testPaths: [/(^|\/)src\/test\//, /(Test|Tests|IT)\.java$/], manifests: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], decisions: null, statements: null },
};

/*
 * The route-table extractors: a framework's route configuration read as an ordered table (each entry's path, guards, redirect,
 * matcher and children), declared per framework with the languages its configuration is written in and the manifest dependency
 * that names it. A repository whose manifests name none states no route table, and its routes' availability stays unexplained.
 */
export type RouteTableSyntax = "angular-router";

const ROUTE_TABLES: Record<RouteTableSyntax, { languages: readonly LanguageId[]; manifest: string; dependency: string; moduleConfigs: readonly string[] }> = {
  /* `moduleConfigs`: the files that configure how the languages resolve a module specifier (`paths`, `baseUrl`, `extends`), the nearest to the importing file first. */
  "angular-router": { languages: ["typescript", "javascript"], manifest: "package.json", dependency: "@angular/router", moduleConfigs: ["tsconfig.json", "jsconfig.json"] },
};

/*
 * The consumer-expectation extractors: what a consumer's own code declares it expects of a response (the type it declares for the
 * answer to a request, and the fields its code reads and never writes), read from the language's declared types. Declared per syntax
 * with the languages it reads and the files that configure how those languages resolve a module specifier. A language with no
 * syntax here yields no expectation, never a guess.
 */
export type ExpectationSyntax = "typescript-declared-types";

const EXPECTATIONS: Record<ExpectationSyntax, { languages: readonly LanguageId[]; moduleConfigs: readonly string[] }> = {
  "typescript-declared-types": { languages: ["typescript", "javascript"], moduleConfigs: ["tsconfig.json", "jsconfig.json"] },
};

/* The manifest files a route-table syntax is named in. */
export const ROUTE_TABLE_MANIFESTS: readonly string[] = Object.freeze([...new Set(Object.values(ROUTE_TABLES).map((t) => t.manifest))].sort());

const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  java: "java",
};

export const LanguageRegistry = {
  supported: new Set<LanguageId>(Object.keys(LANGS) as LanguageId[]) as ReadonlySet<LanguageId>,

  /* Every file extension of a declared language, without the dot. */
  extensions: Object.freeze(Object.keys(EXT_TO_LANGUAGE).sort()) as readonly string[],

  /* Every build-file name of a declared language. */
  manifests: Object.freeze([...new Set(Object.values(LANGS).flatMap((l) => l.manifests))].sort()) as readonly string[],

  languageForFile(file: string): LanguageId | null {
    const dot = file.lastIndexOf(".");
    if (dot < 0) return null;
    return EXT_TO_LANGUAGE[file.slice(dot + 1).toLowerCase()] ?? null;
  },

  groupByLanguage(files: string[]): Map<LanguageId, string[]> {
    const out = new Map<LanguageId, string[]>();
    for (const f of files) {
      const lang = this.languageForFile(f);
      if (!lang) continue;
      const list = out.get(lang) ?? [];
      list.push(f);
      out.set(lang, list);
    }
    return out;
  },

  /* Whether a file is a test of its language, by that language's conventions; a file of no declared language is not. */
  isTestFile(file: string): boolean {
    const lang = this.languageForFile(file);
    return lang !== null && LANGS[lang].testPaths.some((pattern) => pattern.test(file));
  },

  /* The syntax the static decision listing reads a file with, or null for a file of no declared language or of a language with no lister. */
  decisionSyntaxForFile(file: string): DecisionSyntax | null {
    const lang = this.languageForFile(file);
    return lang === null ? null : LANGS[lang].decisions;
  },

  /* The syntax that tells a file's statements that are no executable code, or null for a file of no declared language or of a language that declares none. */
  statementSyntaxForFile(file: string): StatementSyntax | null {
    const lang = this.languageForFile(file);
    return lang === null ? null : LANGS[lang].statements;
  },

  /* The route-table syntaxes whose framework a repository's build file declares (its dependency in a manifest of the syntax's language), in declaration order. */
  routeTableSyntaxesFor(manifest: { file: string; dependencies: ReadonlySet<string> }): RouteTableSyntax[] {
    return (Object.keys(ROUTE_TABLES) as RouteTableSyntax[]).filter((syntax) => {
      const declared = ROUTE_TABLES[syntax];
      return declared.manifest === manifest.file && manifest.dependencies.has(declared.dependency);
    });
  },

  /* Whether a route-table syntax reads a file of this language. */
  routeTableReads(syntax: RouteTableSyntax, file: string): boolean {
    const lang = this.languageForFile(file);
    return lang !== null && ROUTE_TABLES[syntax].languages.includes(lang);
  },

  /* The files, by name, that configure module resolution for the languages a route-table syntax reads. */
  routeTableModuleConfigs(syntax: RouteTableSyntax): readonly string[] {
    return ROUTE_TABLES[syntax].moduleConfigs;
  },

  /* The consumer-expectation syntax that reads a file of a declared language, or null for a file of no declared language or of a language with none. */
  expectationSyntaxFor(file: string): ExpectationSyntax | null {
    const lang = this.languageForFile(file);
    if (lang === null) return null;
    return (Object.keys(EXPECTATIONS) as ExpectationSyntax[]).find((syntax) => EXPECTATIONS[syntax].languages.includes(lang)) ?? null;
  },

  /* The files, by name, that configure module resolution for the languages a consumer-expectation syntax reads. */
  expectationModuleConfigs(syntax: ExpectationSyntax): readonly string[] {
    return EXPECTATIONS[syntax].moduleConfigs;
  },

  hasAstGrepRules(lang: LanguageId): boolean {
    return LANGS[lang]?.astGrep ?? false;
  },
} as const;
