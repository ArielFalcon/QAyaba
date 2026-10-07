/* Which specs a selector contradiction is about. A contradiction names a selector, never the spec, but the checks that raise it know which spec did (the pre-exec gate, per spec and per route, and Lever-2, per spec), and hand that over with it as a ContradictionOrigin. Attribution reads the origins and nothing else: it never looks for the selector's text in the specs, because a spec can hold the same selector and have raised nothing (disambiguated, scoped to a parent, or on a page where it is fine), and the files attributed are the ones a regeneration is asked to change. Pure. */
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { ContradictionOrigin } from "./selector-check.ts";

/* The files, in canonical form, of the specs that raised any of the contradictions: `files[i]` is the file of the spec at index i of the sources the check read. Once each, in the order of the origins. A spec with no file, or a blank one, is left out; no origins (the check did not say) attribute to none. */
export function attributeContradictions(contradictions: readonly string[], origins: readonly ContradictionOrigin[] | undefined, files: readonly string[]): string[] {
  if (origins === undefined) return [];
  const attributed = new Set<string>();
  for (const { contradiction, specIndex } of origins) {
    if (!contradictions.includes(contradiction)) continue;
    const file = normalizeSpecPath(files[specIndex] ?? "");
    if (file !== "") attributed.add(file);
  }
  return [...attributed];
}
