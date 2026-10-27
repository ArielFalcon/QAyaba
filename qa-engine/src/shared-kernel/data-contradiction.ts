/*
 * A possible data contradiction: on one captured page, one data source returns items that carry a key and a source of the same kind
 * returns items that carry it in none (a collection that lists a field and a sibling collection that never has it), which can be the
 * app's defect and not the test's concern. The facts come from the responses the DOM capture read (key names and counts only, never a
 * value), never from a spec's comment. Shared by the grounding that finds them (generation), the briefs (coordination), the reviewer's
 * evidence filter and the gate signal (run-orchestration) and the publication (workspace-and-publication). Values and wording only.
 */
import { pathOnly } from "./route-availability.ts";

export interface DataContradiction {
  /* The address the capture opened (a page of a template when `template` is set). */
  route: string;
  template?: string;
  /* The key the items of one source carry and the items of the other carry in none. */
  key: string;
  /* The source whose items carry the key: `METHOD origin/path`, and how many items it returned. */
  carriedBy: { operation: string; items: number };
  /* The source of the same kind whose items carry it in none. */
  missingFrom: { operation: string; items: number };
  /* Whether the app's OpenAPI response schema for the source that lacks the key declares it. Absent schema, or a schema that declares no fields, backs nothing. */
  schemaBacked: boolean;
}

/* The most facts the gate signal lists; the rest are counted. */
export const MAX_DATA_CONTRADICTIONS_RECORDED = 16;

/* What a run recorded of data contradictions. A signal, never a gate: it reads nothing back into a verdict. */
export interface DataContradictionGateSignal {
  /* Pages the capture read response shapes of. */
  pages: number;
  found: number;
  schemaBacked: number;
  facts: Array<{ route: string; key: string; carriedBy: string; missingFrom: string; schemaBacked: boolean }>;
  omitted: number;
}

export function dataContradictionsSignal(pages: number, facts: readonly DataContradiction[]): DataContradictionGateSignal {
  const listed = facts.slice(0, MAX_DATA_CONTRADICTIONS_RECORDED).map((fact) => ({
    route: fact.route,
    key: fact.key,
    carriedBy: fact.carriedBy.operation,
    missingFrom: fact.missingFrom.operation,
    schemaBacked: fact.schemaBacked,
  }));
  return { pages, found: facts.length, schemaBacked: facts.filter((fact) => fact.schemaBacked).length, facts: listed, omitted: Math.max(0, facts.length - listed.length) };
}

/* What the fact states, with no page in front of it. */
export function dataContradictionStatement(fact: DataContradiction): string {
  const items = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;
  return `${fact.missingFrom.operation} returned ${items(fact.missingFrom.items)}, none with "${fact.key}", while ${fact.carriedBy.operation} returned ${items(fact.carriedBy.items)} of the same kind with it${fact.schemaBacked ? "; the app's OpenAPI response schema for the first declares it" : ""}`;
}

/* What a reviewer cites to name a fact: the page's pathname and the key, `<path>#<key>`. */
export function dataContradictionRef(fact: Pick<DataContradiction, "route" | "key">): string {
  return `${pathOnly(fact.route)}#${fact.key}`;
}

/* A citation's reference in the form facts are compared in (the page as a pathname, the key as written), or undefined when it names no key. */
export function normalizedContradictionRef(ref: string): string | undefined {
  const at = ref.lastIndexOf("#");
  if (at <= 0 || at === ref.length - 1) return undefined;
  return `${pathOnly(ref.slice(0, at).trim())}#${ref.slice(at + 1).trim()}`;
}

/* The refs a run's facts can be cited by: the page by its address, and by its template when it was opened from one. */
export function dataContradictionRefs(facts: readonly DataContradiction[]): Set<string> {
  return new Set(facts.flatMap((fact) => [dataContradictionRef(fact), ...(fact.template !== undefined ? [dataContradictionRef({ route: fact.template, key: fact.key })] : [])]));
}
