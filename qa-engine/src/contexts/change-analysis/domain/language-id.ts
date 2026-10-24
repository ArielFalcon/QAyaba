/* Single language registry for every extractor in this context. `supported` and `hasAstGrepRules` both derive from LANGS — adding a language is one record. Project-agnostic: keyed by language, never by app. */
export type LanguageId = "javascript" | "typescript" | "java";

/* JavaScript and TypeScript share their test conventions: a `.test.` or `.spec.` file, or a file under `__tests__/`. */
const JS_TEST_PATHS: readonly RegExp[] = [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//];

/*
 * astGrep: true → AstGrepPatternAdapter; false → regex fallback. Both `supported` and `hasAstGrepRules` derive from this record.
 * testPaths: the language's own conventions for a test file (the build tool's test source set, the test-runner's file names).
 */
const LANGS: Record<LanguageId, { astGrep: boolean; testPaths: readonly RegExp[] }> = {
  javascript: { astGrep: true, testPaths: JS_TEST_PATHS },
  typescript: { astGrep: true, testPaths: JS_TEST_PATHS },
  java:       { astGrep: true, testPaths: [/(^|\/)src\/test\//, /(Test|Tests|IT)\.java$/] },
};

const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  java: "java",
};

export const LanguageRegistry = {
  supported: new Set<LanguageId>(Object.keys(LANGS) as LanguageId[]) as ReadonlySet<LanguageId>,

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

  hasAstGrepRules(lang: LanguageId): boolean {
    return LANGS[lang]?.astGrep ?? false;
  },
} as const;
