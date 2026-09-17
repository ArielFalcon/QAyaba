/* Single language registry for every extractor in this context. `supported` and `hasAstGrepRules` both derive from LANGS — adding a language is one record. Project-agnostic: keyed by language, never by app. */
export type LanguageId = "javascript" | "typescript" | "java";

/* astGrep: true → AstGrepPatternAdapter; false → regex fallback. Both `supported` and `hasAstGrepRules` derive from this record. */
const LANGS: Record<LanguageId, { astGrep: boolean }> = {
  javascript: { astGrep: true },
  typescript: { astGrep: true },
  java:       { astGrep: true },
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

  hasAstGrepRules(lang: LanguageId): boolean {
    return LANGS[lang]?.astGrep ?? false;
  },
} as const;
