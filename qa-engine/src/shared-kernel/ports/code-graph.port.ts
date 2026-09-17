/* Advisory-only: confidence-bearing queries default to the 0.55 floor and never gate a PR — the graph complements runtime change-coverage, it does not replace it. */

import type { Result } from "@kernel/result.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type {
  LocalSymbolRef,
  CoupledFile,
  SpecCoverage,
  CodeGraphUnavailable,
  IndexFailed,
} from "@kernel/code/index.ts";

export interface CodeGraphPort {
  /** Index/refresh the graph for repoDir over changedFiles. opts.semantic requests embedding-backed edges. Returns node count on success; IndexFailed only on whole-index failure (never per-file). */
  syncTo(
    repoDir: string,
    changedFiles: string[],
    opts?: { semantic?: boolean },
  ): Promise<Result<{ nodeCount: number }, IndexFailed>>;

  /** Symbols structurally impacted by the changed set, up to opts.depth hops. depth is required; minConfidence defaults to the 0.55 advisory floor. */
  impactedSymbols(
    repoDir: string,
    changed: BlastRadius,
    opts: { depth: number; minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;

  /** Files that historically co-change with the given files. */
  coChangeCoupling(
    repoDir: string,
    files: string[],
  ): Promise<Result<CoupledFile[], CodeGraphUnavailable>>;

  /** Callers of a symbol up to `depth` hops. depth is positional (intentional asymmetry vs impactedSymbols.opts.depth), required, no default; minConfidence defaults to the 0.55 floor. */
  callersOf(
    repoDir: string,
    symbol: LocalSymbolRef,
    depth: number,
    opts?: { minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;

  /** Existing spec/test coverage that references the changed symbols. An empty result is not an error — a consumer must not render empty as "no coverage". */
  existingCoverage(
    repoDir: string,
    changed: BlastRadius,
  ): Promise<Result<SpecCoverage[], CodeGraphUnavailable>>;

  /** Symbols structurally related by shared-neighbor similarity (Jaccard). */
  structurallyRelated(
    repoDir: string,
    symbols: LocalSymbolRef[],
    minJaccard?: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;
}
