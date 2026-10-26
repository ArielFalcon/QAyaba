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
  /* Every entry point the engine recognised in the repo, sorted and capped. */
  entryPoints: EntryPoint[];
  entryPointsTruncated: boolean;
}

/* A changed symbol that reaches too many entries (or whose walk the budget cut) proves none of them. */
export interface ScopeHub {
  symbol: string;
  entries: number;
  keys: string[];
  truncated?: boolean;
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
  /* A walk the budget cut: what it reached is a lower bound, even when it proved no entry. */
  walksTruncated?: true;
  /* A repo whose index did not answer: its absence from `reach` proves nothing. */
  degraded: Array<{ repo: string; reason: string }>;
}

export const MAX_KNOWN_ENTRY_POINTS = 2000;
