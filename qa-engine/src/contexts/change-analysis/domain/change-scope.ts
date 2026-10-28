/*
 * The reach of a change: every repo of the change, the entry points (pages and operations) its changed symbols reach, how
 * directly, and the evidence path for each. Values only; the proofs that fill it are strategies (reach-proof.ts). Pure.
 */
import type { ChangeRole } from "@kernel/change-set.ts";
import type { ChangedSymbol, EntryPoint, ReachBasis, ReachTier } from "@kernel/change-reach.ts";

export type { ChangedSymbol, EntryPoint, ReachBasis, ReachTier } from "@kernel/change-reach.ts";
export { entryKey } from "@kernel/change-reach.ts";

export interface ReachEntry {
  entry: EntryPoint;
  tier: ReachTier;
  basis: ReachBasis;
  /* The path from the change to the entry, one step per line. */
  evidence: string[];
  seeds: ChangedSymbol[];
  /* The lowest confidence of an edge on the evidence path. */
  confidence: number;
}

export interface RepoScope {
  repo: string;
  role: ChangeRole;
  indexedSha: string | null;
  changedFiles: string[];
  seeds: ChangedSymbol[];
  seedBasis: "lines" | "whole-file" | "none";
  /* The lines the change added to each changed file; absent when the diff was not read. */
  addedLines?: Record<string, number>;
  /* The changed non-code files each changed source file of the repo declares by relative path literal (a template, a style sheet), keyed by the source file; absent when none does. */
  declaredResources?: Record<string, string[]>;
  /* Every entry point the engine recognised in the repo, sorted and capped. */
  entryPoints: EntryPoint[];
  entryPointsTruncated: boolean;
}

/*
 * A changed symbol that reaches too many entries proves none of them; neither does a node the walk pruned at its fan-in limit
 * (`via: "fan-in"`), whose keys are what its closure reaches and whose `seeds` are the changed symbols that reach it.
 * `truncated`: the keys are a lower bound (a partial seed, or a closure its budget cut).
 */
export interface ScopeHub {
  symbol: string;
  entries: number;
  keys: string[];
  truncated?: boolean;
  via?: "fan-in";
  fanIn?: number;
  seeds?: string[];
}

export interface ScopeDisagreement {
  route: string;
  mapFiles: string[];
  engineFile: string;
}

export interface ChangeScope {
  repos: RepoScope[];
  reach: ReachEntry[];
  hubs: ScopeHub[];
  disagreements: ScopeDisagreement[];
  omitted: number;
  /* A walk whose answer is a lower bound for a seed (a partial seed, or seeds past the walk's bound): no absence is proven. */
  walksTruncated?: true;
  /* The changed symbols the walk's budget left partial, as `file::symbol`: their entries stand, ranked after complete ones. */
  partialSeeds?: string[];
  /* A repo whose index did not answer: its absence from `reach` proves nothing. */
  degraded: Array<{ repo: string; reason: string }>;
}

export const MAX_KNOWN_ENTRY_POINTS = 2000;
