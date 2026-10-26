import type { SelectedExemplar } from "@kernel/learned-rule.ts";
import type { CurriculumFoldInput } from "../../domain/curriculum-model.ts";

/**
 * Per-app scenario-archetype prior. Optional and off-path: absent is today's
 * run; a curriculum fault never gates a verdict or publish. Selection lives
 * behind the port so "what we offered" cannot drift from "what we folded".
 */
export interface CurriculumPort {
  /**
   * Absent diff (non-diff modes) → []: no patterns, nothing offered, nothing folded.
   * Data-driven, not a mode branch.
   */
  select(diff: string | undefined, changedFiles: readonly string[]): Promise<readonly SelectedExemplar[]>;
  fold(input: CurriculumFoldInput): Promise<void>;
}
