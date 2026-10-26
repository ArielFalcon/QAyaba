import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CandidateValue, FaultAim, ValueStats } from "../../domain/fault-injection-score.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { CoverageMeasurement } from "../../domain/objective-signal.ts";

export interface ObjectiveSignalPort {
  /**
   * `valueScore` absent means not measured — never a fabricated 0.
   * `mutantCount`/`killedCount` mirror the value-oracle's own ValueOracleResult: absent means the
   * oracle never ran this measure() call (e.g. coverage.mode "off"); `null` means it ran but has no
   * count to report. Neither is ever fabricated as 0 — that would read as a genuine measured zero.
   * `diff` absent (non-diff modes) → assembler never invoked → decide() gets
   * null → "unknown" → never blocks.
   * `baselineCases` are this run's passing case names; absent falls back to the
   * static composition-time list.
   * `uncovered` is populated only when a ChangeCoverage was actually assembled;
   * never fabricated as [].
   * `opts.candidates` are the use cases the change makes testable: the measurement then carries `perCandidate`, a signal that
   * never gates. `opts.crossRepo` says the diff was withheld because the changed lines live in another repo.
   * `opts.faultAim` is what the response oracle may corrupt and for which use cases; without it the oracle gives no score
   * (`valueScore` null) and `valueByCandidate` is absent. It is a signal and never gates.
   * `opts.namespace` overrides the dump namespace for the regen's second
   * measure(); the first measurement is untouched.
   */
  measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string; candidates?: readonly UseCaseCandidate[]; crossRepo?: boolean; faultAim?: FaultAim }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; valueByCandidate?: CandidateValue[]; valueStats?: ValueStats; mutantCount?: number | null; killedCount?: number | null; uncovered?: { file: string; lines: number[] }[]; measurement?: CoverageMeasurement }>;
  /**
   * Single source of truth for whether a measured status blocks publish.
   * Only "enforce" + "fail" blocks; "unknown" never blocks regardless of mode.
   */
  blocks(status: "pass" | "fail" | "unknown"): boolean;
}
