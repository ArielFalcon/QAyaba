/*
 * Use-case candidates: the entry points a change reaches, made testable. A candidate is a reach entry with a stable id,
 * whether a browser can reach it, and the specs the suite already holds for it. The context map, the manifest and the suite's
 * files are enrichment: with none of them the candidates exist from the scope alone. Pure.
 */
import { sha256Hex } from "@kernel/content-hash.ts";
import { entryKey, type EntryPoint, type ReachBasis, type ReachTier } from "@kernel/change-reach.ts";
import { normalizeRoute, type PageMap } from "./page-files.ts";
import { FILE_SEED_SYMBOL, type CandidateChangedFile, type Reachability, type SharedSeed, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ChangeScope, ReachEntry } from "./change-scope.ts";

export type { Reachability, UseCaseCandidate } from "@kernel/use-case-candidate.ts";

/* A page the map links to a changed file (its implementation files, its source, or the spec of an operation it joins). */
export interface MapLink {
  repo: string;
  route: string;
  basis: Extract<ReachBasis, "implementation" | "source" | "spec">;
  /* The changed files that made the map link the page, as the diff names them. */
  files: readonly string[];
}

export interface CandidateEnrichment {
  map?: PageMap;
  mapLinks?: readonly MapLink[];
  /* The suite's manifest entries: what each spec says it targets. */
  manifest?: ReadonlyArray<{ file?: string; useCase?: string; objective?: string; targets: readonly string[] }>;
  /* The suite's files with their text, read through the confined reader. */
  suiteFiles?: ReadonlyArray<{ file: string; text: string }>;
}

/* The order candidates are offered in: a change's own pages first, then those reached through the call graph, then across repos. */
const TIER_ORDER: Readonly<Record<ReachTier, number>> = { direct: 0, indirect: 1, "cross-repo": 2 };
const BASIS_ORDER: Readonly<Record<ReachBasis, number>> = { implementation: 0, source: 1, spec: 2, handler: 3, contract: 3, graph: 4, "call-site": 4 };

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

export function candidateId(entry: EntryPoint): string {
  return `uc-${sha256Hex(`${entry.kind}\0${entry.repo}\0${entryKey(entry)}`).slice(0, 8)}`;
}

/* A route or URL as its comparable pathname: no origin, query or fragment, no edge or doubled slash. */
function pathOf(target: string): string {
  const withoutOrigin = target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  return normalizeRoute(withoutOrigin.split(/[?#]/)[0] ?? "");
}

/* Whether a pathname opens the route: equal, or equal segment by segment where the route has a `:parameter` or `{parameter}` segment. */
function opensRoute(route: string, pathname: string): boolean {
  const wanted = normalizeRoute(route).split("/");
  const got = pathname.split("/");
  if (wanted.length !== got.length) return false;
  return wanted.every((segment, i) => segment === got[i] || /^(:|\{)/.test(segment));
}

const GOTO = /\bgoto\(\s*(['"`])([^'"`\n]*)\1/g;

function suiteOpening(route: string, files: CandidateEnrichment["suiteFiles"]): string[] {
  const out: string[] = [];
  for (const { file, text } of files ?? []) {
    for (const m of text.matchAll(GOTO)) {
      if (opensRoute(route, pathOf(m[2]!))) {
        out.push(file);
        break;
      }
    }
  }
  return out;
}

function existingSpecsOf(entry: EntryPoint, label: string | undefined, enrichment: CandidateEnrichment): string[] {
  const named = (enrichment.manifest ?? []).filter((m) => {
    if (m.file === undefined) return false;
    if (label !== undefined && m.useCase !== undefined && m.useCase === label) return true;
    return m.targets.some((target) => {
      if (entry.kind === "page") return opensRoute(entry.route, pathOf(target));
      return target.trim().toUpperCase() === `${entry.verb.toUpperCase()} ${entry.path}`.toUpperCase() || target.trim() === entry.path;
    });
  }).map((m) => m.file!);
  const opening = entry.kind === "page" ? suiteOpening(entry.route, enrichment.suiteFiles) : [];
  return [...new Set([...named, ...opening])].sort();
}

/* The objectives the manifest declares for the existing specs, in manifest order, once each; a spec without one is left out. */
function objectivesOf(specs: readonly string[], enrichment: CandidateEnrichment): Record<string, string[]> | undefined {
  const held = new Set(specs);
  const out: Record<string, string[]> = {};
  for (const m of enrichment.manifest ?? []) {
    if (m.file === undefined || !held.has(m.file) || m.objective === undefined || m.objective.trim() === "") continue;
    const list = (out[m.file] ??= []);
    if (!list.includes(m.objective)) list.push(m.objective);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const sameOperationPath = (a: string, b: string): boolean => normalizeRoute(a.replace(/\{[^}]*\}|:[^/]+/g, ":")) === normalizeRoute(b.replace(/\{[^}]*\}|:[^/]+/g, ":"));

/* The pages through which a browser reaches an operation: those the map joins to it and those whose reach crossed it as a call site. */
function pagesReaching(entry: Extract<EntryPoint, { kind: "operation" }>, reach: readonly ReachEntry[], map: PageMap | undefined): string[] {
  const verb = entry.verb.toUpperCase();
  const prefix = `${entry.repo}: ${verb} ${entry.path}`;
  const bySite = reach.flatMap((r) => (r.entry.kind === "page" && r.evidence[0]?.startsWith(prefix) ? [r.entry.route] : []));
  const operationIds = new Set((map?.api ?? []).filter((op) => isText(op.method) && isText(op.path) && op.method.toUpperCase() === verb && sameOperationPath(op.path, entry.path)).map((op) => op.operationId));
  const byMap = (map?.feBe ?? []).flatMap((link) => (isText(link.route) && operationIds.has(link.operationId) ? [link.route] : []));
  return [...new Set([...bySite, ...byMap])].sort();
}

function labelOf(entry: EntryPoint, map: PageMap | undefined): string | undefined {
  if (entry.kind !== "page") return undefined;
  const route = (map?.routes ?? []).find((r) => isText(r.path) && normalizeRoute(r.path) === normalizeRoute(entry.route));
  return isText(route?.name) ? route.name : undefined;
}

/* The changed files that seed a candidate, once each, with the lines the change added to them in the repo that holds them. */
function changedFilesOf(seeds: readonly { file: string }[], scope: ChangeScope, repo: string): CandidateChangedFile[] {
  const repos = [...scope.repos.filter((r) => r.repo === repo), ...scope.repos.filter((r) => r.repo !== repo)];
  return [...new Set(seeds.map((seed) => seed.file))].sort().map((file) => {
    const addedLines = repos.map((r) => r.addedLines?.[file]).find((n) => n !== undefined);
    return { file, ...(addedLines !== undefined ? { addedLines } : {}) };
  });
}

/* The hubs whose keys name the entry, as shared seeds: the hub's changed symbol with its range, the pages it reaches and the lines added to its file. A hub never creates a candidate; this only enriches one that exists. */
function sharedSeedsOf(entry: EntryPoint, scope: ChangeScope): SharedSeed[] {
  const key = entryKey(entry);
  const seeds = scope.repos.flatMap((r) => r.seeds.map((seed) => ({ seed, addedLines: r.addedLines?.[seed.file] })));
  return scope.hubs.filter((hub) => hub.keys.includes(key)).flatMap((hub) => {
    const held = seeds.find(({ seed }) => `${seed.file}::${seed.symbol}` === hub.symbol);
    if (held === undefined) return [];
    const pages = hub.keys.filter((k) => k.startsWith("page ")).length;
    return [{ ...held.seed, pages, ...(held.addedLines !== undefined ? { addedLines: held.addedLines } : {}) }];
  });
}

export function deriveCandidates(scope: ChangeScope, enrichment: CandidateEnrichment = {}): UseCaseCandidate[] {
  const held = new Set(scope.reach.map((r) => entryKey(r.entry)));
  const linked: ReachEntry[] = (enrichment.mapLinks ?? [])
    .filter((link) => !held.has(entryKey({ kind: "page", repo: link.repo, route: link.route })))
    .map((link) => ({
      entry: { kind: "page", repo: link.repo, route: link.route },
      tier: "direct",
      basis: link.basis,
      evidence: [`the map links page ${link.route} to a changed file (${link.basis})`],
      seeds: link.files.map((file) => ({ file, symbol: FILE_SEED_SYMBOL })),
      confidence: 1,
    }));
  const entries = [...scope.reach, ...linked];
  const candidates = entries.map((r): UseCaseCandidate => {
    const pages = r.entry.kind === "operation" ? pagesReaching(r.entry, scope.reach, enrichment.map) : [];
    const reachability: Reachability = r.entry.kind === "page" ? "page" : pages.length > 0 ? "via-page" : "backend-only";
    const label = labelOf(r.entry, enrichment.map);
    const existingSpecs = existingSpecsOf(r.entry, label, enrichment);
    const specObjectives = objectivesOf(existingSpecs, enrichment);
    const sharedSeeds = sharedSeedsOf(r.entry, scope);
    return {
      id: candidateId(r.entry),
      entry: r.entry,
      tier: r.tier,
      basis: r.basis,
      evidence: [...r.evidence],
      seeds: [...r.seeds],
      ...(sharedSeeds.length > 0 ? { sharedSeeds } : {}),
      changedFiles: changedFilesOf(r.seeds, scope, r.entry.repo),
      confidence: r.confidence,
      reachability,
      pages,
      existingSpecs,
      ...(specObjectives !== undefined ? { specObjectives } : {}),
      ...(label !== undefined ? { label } : {}),
    };
  });
  return candidates.sort((a, b) =>
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis] || b.confidence - a.confidence || a.evidence.length - b.evidence.length || entryKey(a.entry).localeCompare(entryKey(b.entry)),
  );
}
