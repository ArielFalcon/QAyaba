/*
 * Possible data contradictions of a captured page, from the shapes of the JSON responses its code read: operation B contradicts
 * operation A on key K when A's items carry K in at least one item, B returned at least one item and none of them carries K, and A
 * and B are the same kind of resource. A key present with a `null` value is present (the capture records key names, not values).
 * A signal for the author and the human reading the PR or the Issue, never a gate: a missing key can be a deliberate projection or an
 * optional field, so the rule is built to stay quiet unless the two sources look alike. Pure.
 *
 * "The same kind of resource" is the overlap of the two sources' key sets with the contested key left out: the keys they share over
 * the keys either has. Two collections of one resource (a list and the same list narrowed by a path parameter) differ by a field or
 * two; a deliberate projection (`id`, `name`) or an unrelated resource shares a small part of the wider one. The overlap has to reach
 * `SAME_KIND_MIN_OVERLAP` and the two have to share `SAME_KIND_MIN_SHARED_KEYS` keys, so that small objects, whose few keys are
 * all alike, do not pass for one resource. Those two numbers decide how loud the signal is: higher costs the contradictions of
 * resources that differ more, lower adds the look-alike resources and the projections. When the app's OpenAPI response schema for B is
 * known, it settles what the keys alone cannot: a schema that declares K for B backs the fact, and a schema that declares B's fields
 * without K says B is not meant to carry it, which is no contradiction.
 */
import type { DataContradiction } from "@kernel/data-contradiction.ts";
import type { DataShape, PageDataShapes } from "./route-snapshot.ts";

/* Keys the two sources share over the keys either has, the contested key left out. Reason above. */
export const SAME_KIND_MIN_OVERLAP = 0.8;
/* Keys the two sources must share before their overlap says anything. */
export const SAME_KIND_MIN_SHARED_KEYS = 3;
/* A safety bound on what a page can make the rule report (the shapes come from an untrusted page); what is left out is counted. */
export const MAX_CONTRADICTIONS_PER_PAGE = 20;

/* A captured page and the shapes of the responses its code read. */
export interface PageShapes {
  route: string;
  template?: string;
  shapes: PageDataShapes;
}

/* The fields the app's OpenAPI response schema declares for the items an operation returns; undefined when no schema is known for it or it declares none. */
export type ResponseFieldsOf = (method: string, url: string) => ReadonlySet<string> | undefined;

const operationOf = (shape: DataShape): string => `${shape.method} ${shape.url}`;

function contradictionsOfPage(page: PageShapes, fieldsOf: ResponseFieldsOf | undefined): DataContradiction[] {
  const shapes = page.shapes.listed;
  const found: DataContradiction[] = [];
  for (const missing of shapes) {
    if (!missing.complete || missing.items < 1) continue;
    const declared = fieldsOf?.(missing.method, missing.url);
    const has = new Set(missing.keys);
    const candidates = new Map<string, { source: DataShape; backed: boolean }>();
    for (const source of shapes) {
      if (source === missing || source.method !== missing.method || source.url === missing.url) continue;
      const shared = source.keys.filter((key) => has.has(key)).length;
      if (shared < SAME_KIND_MIN_SHARED_KEYS) continue;
      const union = new Set([...source.keys, ...missing.keys]).size;
      for (const key of source.keys) {
        if (has.has(key)) continue;
        /* The contested key is in the union through the source only. */
        if (shared / (union - 1) < SAME_KIND_MIN_OVERLAP) continue;
        if (declared !== undefined && declared.size > 0 && !declared.has(key)) continue;
        const held = candidates.get(key);
        if (held === undefined || source.items > held.source.items) candidates.set(key, { source, backed: declared?.has(key) === true });
      }
    }
    for (const key of [...candidates.keys()].sort()) {
      const { source, backed } = candidates.get(key)!;
      found.push({
        route: page.route,
        ...(page.template !== undefined ? { template: page.template } : {}),
        key,
        carriedBy: { operation: operationOf(source), items: source.items },
        missingFrom: { operation: operationOf(missing), items: missing.items },
        schemaBacked: backed,
      });
    }
  }
  return found;
}

/* The possible contradictions of the pages, in the order of their pages, their sources and then the key; at most MAX_CONTRADICTIONS_PER_PAGE a page, and how many that left out. `pages` is how many pages had a shape to read. */
export function findDataContradictions(pages: readonly PageShapes[], fieldsOf?: ResponseFieldsOf): { facts: DataContradiction[]; omitted: number; pages: number } {
  const facts: DataContradiction[] = [];
  let omitted = 0;
  for (const page of pages) {
    const found = contradictionsOfPage(page, fieldsOf);
    facts.push(...found.slice(0, MAX_CONTRADICTIONS_PER_PAGE));
    omitted += Math.max(0, found.length - MAX_CONTRADICTIONS_PER_PAGE);
  }
  return { facts, omitted, pages: pages.filter((page) => page.shapes.listed.length > 0).length };
}
