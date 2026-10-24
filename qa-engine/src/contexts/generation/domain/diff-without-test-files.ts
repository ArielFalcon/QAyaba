/*
 * A commit's diff without the app's own test files, which are named instead. A lead plans the end-to-end flows a change needs; the
 * unit tests the change carries are the app's, and their bodies would only crowd the diff it plans from. What counts as a test file
 * is the language registry's. Pure.
 */
import { LanguageRegistry } from "@contexts/change-analysis/domain/language-id.ts";

const FILE_HEADER = /^diff --git a\/\S+ b\/(\S+)/;

export function diffWithoutTestFiles(diff: string): { diff: string; testFiles: string[] } {
  const sections = diff.split(/^(?=diff --git )/m);
  const testFiles: string[] = [];
  const kept = sections.filter((section) => {
    const path = FILE_HEADER.exec(section)?.[1];
    if (path === undefined || !LanguageRegistry.isTestFile(path)) return true;
    testFiles.push(path);
    return false;
  });
  return { diff: testFiles.length === 0 ? diff : kept.join(""), testFiles };
}
