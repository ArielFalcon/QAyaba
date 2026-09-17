
import type { CurriculumPort, CurriculumFoldInput, SelectedExemplar } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { MAX_SELECTED_EXEMPLARS } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";
import { matchExemplars, type SkillExemplar } from "@kernel/scenario-catalog.ts";
import {
  initCurriculum, normalizeCurriculum, classifyEvidence, foldCurriculum, rankExemplars,
  type Curriculum,
} from "../domain/curriculum.ts";

export type CurriculumLoad = (app: string) => Curriculum | null;
export type CurriculumSave = (curriculum: Curriculum) => void;

export class CurriculumPortAdapter implements CurriculumPort {
  constructor(
    private readonly app: string,
    private readonly loadFn: CurriculumLoad,
    private readonly saveFn: CurriculumSave,
    private readonly onError: (err: unknown) => void = (err) =>
      console.warn("[CurriculumPortAdapter] off-path failure, swallowed:", err),
  ) {}

  async select(diff: string | undefined, changedFiles: readonly string[]): Promise<readonly SelectedExemplar[]> {
    if (!diff) return [];
    try {
      const curriculum = this.read();
      const patterns = detectStructuralPatterns(diff, [...changedFiles]);
      const matched = dedupeById(patterns.flatMap((p) => matchExemplars(p)));
      if (matched.length === 0) return [];
      const byArchetype = new Map(curriculum.archetypes.map((e) => [e.archetype as string, e]));
      return rankExemplars(curriculum, matched)
        .slice(0, MAX_SELECTED_EXEMPLARS)
        .map((e) => ({
          id: e.id,
          name: e.name,
          template: e.template,
          archetype: e.archetype,
          proven: byArchetype.get(e.archetype)?.caughtRealBug === true,
          promotionCount: byArchetype.get(e.archetype)?.promotionCount ?? 0,
        }));
    } catch (err) {
      this.onError(err);
      return [];
    }
  }

  async fold(input: CurriculumFoldInput): Promise<void> {
    if (input.offered.length === 0) return;
    try {
      const evidence = classifyEvidence({
        verdict: input.verdict,
        ...(input.adjudicationClass !== undefined ? { adjudicationClass: input.adjudicationClass } : {}),
        ...(input.coverageStatus !== undefined ? { coverageStatus: input.coverageStatus } : {}),
      });
      if (evidence === "inconclusive") return;
      const before = this.read();
      const after = foldCurriculum(before, input.offered, evidence, new Date().toISOString());
      if (after === before) return;
      this.saveFn(after);
    } catch (err) {
      this.onError(err);
    }
  }

  private read(): Curriculum {
    const raw = this.loadFn(this.app);
    return raw ? normalizeCurriculum(raw, this.app) : initCurriculum(this.app);
  }
}

function dedupeById(exemplars: readonly SkillExemplar[]): SkillExemplar[] {
  const seen = new Set<string>();
  return exemplars.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}
