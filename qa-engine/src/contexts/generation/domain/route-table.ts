/*
 * An app's route table, as a route-table extractor reads it from the router configuration (an ordered list of entries, each with
 * its path, guards, redirect, matcher and children, a lazily loaded child table attached under the entry that loads it), and the
 * two questions availability asks of it: which entries decide where an address goes (first match wins, so the entries that can
 * match before it and the fallbacks decide too), and whether those entries are the same at the base and at head. Pure.
 */
import type { ChangeClosure } from "@kernel/route-availability.ts";
import type { DeclarationEvidence, GuardEvidence } from "./route-availability-classifier.ts";

/* A guard an entry lists: its name and the file that declares it. `file` is absent when the extractor could not place it (an inline function, an alias it cannot resolve); `external` when it comes from an installed package, which the change cannot edit. */
export interface GuardRef {
  name: string;
  file?: string;
  external?: true;
}

export interface RouteEntry {
  file: string;
  line: number;
  endLine: number;
  /* The path, constants resolved; absent when the extractor could not resolve it to text. */
  path?: string;
  /* `pathMatch: 'full'`. */
  pathMatchFull: boolean;
  /* A custom matcher decides, not the path. */
  matcher: boolean;
  /* The entry redirects. */
  redirect: boolean;
  /* The entry's own configuration (its children excluded), normalized: two entries with the same signature route the same way. */
  signature: string;
  guards: GuardRef[];
  /* Inline children. */
  children?: RouteEntry[];
  /* A lazily loaded child table: its entries once the extractor read them; `unresolved` when it could not. */
  lazy?: { children?: RouteEntry[]; unresolved?: true };
  /* The links of this entry the extractor could not follow (its path, a guard it could not place, the table it loads), each naming where and what did not resolve. Not part of the signature. */
  unresolved?: string[];
}

/* The root tables of an app (normally one). */
export interface RouteTable {
  roots: RouteEntry[][];
}

/* One level of a match: the entry that took the address, the entries before it at that level that could take it too (a guard, a matcher or an unresolved path decides them), and the level's fallbacks. */
export interface MatchStep {
  entry: RouteEntry;
  before: RouteEntry[];
  fallbacks: RouteEntry[];
}

/* `unknown`: why the match cannot be told; `links` the unresolved links of the entries that stopped it. */
export type RouteMatch = { steps: MatchStep[] } | { unknown: string; links: string[] };

const isWildcard = (entry: RouteEntry): boolean => entry.path === "**";
const segmentsOf = (path: string): string[] => path.split(/[?#]/)[0]!.split("/").filter((s) => s !== "");
const childTable = (entry: RouteEntry): RouteEntry[] | undefined => entry.children ?? entry.lazy?.children;
const hasChildren = (entry: RouteEntry): boolean => entry.children !== undefined || entry.lazy !== undefined;

type EntryMatch = "no" | "maybe" | { consumed: number; descend: boolean };

function entryMatch(entry: RouteEntry, segments: readonly string[]): EntryMatch {
  if (entry.matcher || entry.path === undefined) return "maybe";
  if (isWildcard(entry)) return { consumed: segments.length, descend: false };
  const own = segmentsOf(entry.path);
  if (own.length > segments.length) return "no";
  for (let i = 0; i < own.length; i++) if (!own[i]!.startsWith(":") && own[i] !== segments[i]) return "no";
  if (hasChildren(entry)) return { consumed: own.length, descend: true };
  /* An empty path that redirects with the default prefix match takes every address. */
  if (own.length === 0 && entry.redirect && !entry.pathMatchFull) return { consumed: segments.length, descend: false };
  return own.length === segments.length ? { consumed: own.length, descend: false } : "no";
}

function matchIn(table: readonly RouteEntry[], segments: readonly string[]): RouteMatch | undefined {
  const before: RouteEntry[] = [];
  for (const entry of table) {
    const match = entryMatch(entry, segments);
    if (match === "no") continue;
    if (match === "maybe") {
      before.push(entry);
      continue;
    }
    const fallbacks = table.filter((other) => other !== entry && isWildcard(other));
    const step: MatchStep = { entry, before: [...before], fallbacks };
    if (!match.descend) return { steps: [step] };
    const children = childTable(entry);
    if (children === undefined) {
      const unknown = `${entry.file}:${entry.line} loads its children from a table that could not be read`;
      const own = [...before, entry].flatMap((e) => e.unresolved ?? []);
      return { unknown, links: own.length > 0 ? own : [unknown] };
    }
    const rest = segments.slice(match.consumed);
    const below = matchIn(children, rest);
    if (below !== undefined && "unknown" in below) return below;
    if (below !== undefined) return { steps: [step, ...below.steps] };
    /* No child takes what is left: an exhausted address stays on the parent; otherwise the router goes on to the next entry, and this one could take the address after a change of its children. */
    if (rest.length === 0) return { steps: [step] };
    before.push(entry);
  }
  return undefined;
}

/* The entries that decide where `route` goes, level by level, or why that cannot be told. Undefined when no entry takes it. */
export function matchRoute(table: RouteTable, route: string): RouteMatch | undefined {
  const segments = segmentsOf(route);
  for (const root of table.roots) {
    const match = matchIn(root, segments);
    if (match !== undefined) return match;
  }
  return undefined;
}

/* The unresolved links of the entries of a table that may take the address (their path or matcher could not be read), through the levels it descends. */
function maybeLinks(table: readonly RouteEntry[], segments: readonly string[], out: string[]): void {
  for (const entry of table) {
    const match = entryMatch(entry, segments);
    if (match === "no") continue;
    if (match === "maybe") out.push(...(entry.unresolved ?? []));
    else if (match.descend) maybeLinks(childTable(entry) ?? [], segments.slice(match.consumed), out);
  }
}

/* The most unresolved links a route's evidence names; the rest are counted in one closing entry. */
export const MAX_UNRESOLVED_LINKS = 8;

/*
 * The links the extractor could not follow in the entries that decide `route` at head and at the base (a path or a guard it could
 * not resolve, a child table it could not read), each naming where and what, or why no entry takes the route at all. In the
 * order met, without repeats; what passes the bound is counted.
 */
export function unresolvedLinks(head: RouteTable, base: RouteTable, route: string): string[] {
  const links: string[] = [];
  const tables = [head, base];
  const matches = tables.map((table) => matchRoute(table, route));
  if (matches.every((match) => match === undefined)) links.push(`no entry of the route table takes ${route}`);
  matches.forEach((match, i) => {
    if (match === undefined) {
      /* Nothing took the address: the entries whose path could not be read are the ones that may have. */
      for (const root of tables[i]!.roots) maybeLinks(root, segmentsOf(route), links);
    } else if ("unknown" in match) {
      links.push(...match.links);
    } else {
      for (const step of match.steps) for (const entry of [...step.before, step.entry]) links.push(...(entry.unresolved ?? []));
    }
  });
  const distinct = [...new Set(links)];
  return distinct.length <= MAX_UNRESOLVED_LINKS ? distinct : [...distinct.slice(0, MAX_UNRESOLVED_LINKS), `${distinct.length - MAX_UNRESOLVED_LINKS} more unresolved links`];
}

/* Every guard the deciding entries list: the matched entries' own (a parent's apply to its children) and those of the entries that could match before them. */
export function guardsOf(match: { steps: MatchStep[] }): GuardRef[] {
  const seen = new Set<string>();
  const out: GuardRef[] = [];
  for (const step of match.steps) {
    for (const entry of [...step.before, step.entry]) {
      for (const guard of entry.guards) {
        const key = `${guard.file ?? "?"}::${guard.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(guard);
      }
    }
  }
  return out;
}

/*
 * E2: whether a changed symbol reaches a guard the deciding entries list, through the closure the code graph walked from the
 * change's symbols (the changed symbols themselves included). A route with no guard needs no walk. Otherwise `unreached` holds
 * only when every guard was placed (an installed package's guard cannot be changed by the repository) and the closure was
 * complete; any other case is `partial`. Undefined when a guard was listed and no closure was given.
 */
export function guardEvidence(guards: readonly GuardRef[], closure: ChangeClosure | undefined): GuardEvidence | undefined {
  if (guards.length === 0) return { status: "unreached" };
  const reached = closure === undefined ? undefined : new Set(closure.symbols.map((s) => `${s.file}::${s.symbol}`));
  const hit = guards.find((guard) => guard.file !== undefined && reached?.has(`${guard.file}::${guard.name}`) === true);
  if (hit !== undefined) return { status: "reached", at: `${hit.file}::${hit.name}` };
  if (closure === undefined) return undefined;
  if (guards.some((guard) => guard.file === undefined && guard.external !== true)) return { status: "partial" };
  return closure.complete ? { status: "unreached" } : { status: "partial" };
}

const at = (entry: RouteEntry): string => `${entry.file}:${entry.line}`;
const signatures = (entries: readonly RouteEntry[]): string => entries.map((entry) => entry.signature).join("\n");

/*
 * E1: whether the entries that decide `route` are the same at the base and at head. The route's own entries (and its parents')
 * differing, a route that existed at the base and is gone at head, or one that is new, is `changed`; only the entries that
 * could match before it or the fallbacks differing cannot be placed, so it is `unknown`; all the same is `unchanged`, cited at
 * the route's own entry. A table that could not be read is `unknown`.
 */
export function declarationEvidence(head: RouteTable, base: RouteTable, route: string): DeclarationEvidence {
  const now = matchRoute(head, route);
  const before = matchRoute(base, route);
  if ((now !== undefined && "unknown" in now) || (before !== undefined && "unknown" in before)) return { status: "unknown" };
  if (now === undefined && before === undefined) return { status: "unknown" };
  if (now === undefined) return { status: "changed", at: `${at(before!.steps[before!.steps.length - 1]!.entry)} (removed at head)` };
  if (before === undefined) return { status: "changed", at: at(now.steps[now.steps.length - 1]!.entry) };
  const own = now.steps[now.steps.length - 1]!.entry;
  const chainNow = now.steps.map((step) => step.entry);
  const chainBefore = before.steps.map((step) => step.entry);
  if (signatures(chainNow) !== signatures(chainBefore)) {
    /* Cited where the difference is: an entry of head's chain the base lacks (a fallback last), else the base's entry head lost. */
    const added = chainNow.filter((entry) => !chainBefore.some((b) => b.signature === entry.signature));
    const removed = chainBefore.filter((entry) => !chainNow.some((n) => n.signature === entry.signature));
    const own = added.find((entry) => !isWildcard(entry));
    if (own !== undefined) return { status: "changed", at: at(own) };
    if (removed.length > 0) return { status: "changed", at: `${at(removed[removed.length - 1]!)} (removed at head)` };
    return { status: "changed", at: at(added[0] ?? chainNow[chainNow.length - 1]!) };
  }
  const sameLevels = (pick: (step: MatchStep) => RouteEntry[]): boolean =>
    now.steps.length === before.steps.length && now.steps.every((step, i) => signatures(pick(step)) === signatures(pick(before.steps[i]!)));
  if (!sameLevels((step) => step.before) || !sameLevels((step) => step.fallbacks)) return { status: "unknown" };
  return { status: "unchanged", at: at(own) };
}
