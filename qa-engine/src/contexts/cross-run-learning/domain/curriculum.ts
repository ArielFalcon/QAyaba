/* Per-app prior over scenario archetypes. Pure, never throws. caughtRealBug is strictly the adjudicator's app_defect verdict — never coverage. unknown coverage never becomes evidence. */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import { ALL_ARCHETYPES, type ScenarioArchetype } from "@kernel/scenario-archetype.ts";
import { BUILT_IN_EXEMPLARS, type SkillExemplar } from "@kernel/scenario-catalog.ts";

export interface ArchetypeEntry {
  archetype: ScenarioArchetype;
  /* STRICTLY the adjudicator's app_defect verdict — never coverage. The intelligence view, the TUI and chat.ts all render this as "proven by a real bug"; widening it would make those surfaces lie. */
  caughtRealBug: boolean;
  firstCaughtAt: string | null;
  promotionCount: number;
  lastPromoted: string | null;
  evaluated: number;
  credited: number;
}

export interface Curriculum {
  app: string;
  updatedAt: string;
  archetypes: ArchetypeEntry[];
}

export type CurriculumEvidence = "bug" | "covered" | "uncovered" | "inconclusive";

export interface EvidenceInput {
  verdict: RunVerdict;
  adjudicationClass?: string;
  coverageStatus?: "pass" | "fail" | "unknown";
}

export function initCurriculum(app: string): Curriculum {
  return {
    app,
    updatedAt: new Date().toISOString(),
    archetypes: ALL_ARCHETYPES.map(blankEntry),
  };
}

function blankEntry(archetype: ScenarioArchetype): ArchetypeEntry {
  return { archetype, caughtRealBug: false, firstCaughtAt: null, promotionCount: 0, lastPromoted: null, evaluated: 0, credited: 0 };
}

export function normalizeCurriculum(raw: unknown, app: string): Curriculum {
  const stored = new Map<string, Partial<ArchetypeEntry>>();
  if (raw && typeof raw === "object" && Array.isArray((raw as Curriculum).archetypes)) {
    for (const e of (raw as Curriculum).archetypes) {
      if (e && typeof e.archetype === "string") stored.set(e.archetype, e);
    }
  }
  return {
    app,
    updatedAt: typeof (raw as Curriculum)?.updatedAt === "string" ? (raw as Curriculum).updatedAt : new Date().toISOString(),
    archetypes: ALL_ARCHETYPES.map((archetype) => {
      const prior = stored.get(archetype);
      if (!prior) return blankEntry(archetype);
      return {
        archetype,
        caughtRealBug: prior.caughtRealBug === true,
        firstCaughtAt: typeof prior.firstCaughtAt === "string" ? prior.firstCaughtAt : null,
        promotionCount: nonNegative(prior.promotionCount),
        lastPromoted: typeof prior.lastPromoted === "string" ? prior.lastPromoted : null,
        evaluated: nonNegative(prior.evaluated),
        credited: nonNegative(prior.credited),
      };
    }),
  };
}

function nonNegative(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function classifyEvidence(input: EvidenceInput): CurriculumEvidence {
  /* app_defect is the adjudicator's deterministic "a test caught a real application bug" verdict (adjudicate.service.ts Rules 2.5/2.6/3). It outranks coverage: catching a real defect is the strongest possible evidence an archetype was worth generating. */
  if (input.adjudicationClass === "app_defect") return "bug";
  /* Below the bug tier only a GREEN run carries a readable signal. A failing run adjudicated anything other than app_defect indicts the generated test, not the archetype it came from; flaky/invalid/infra-error/skipped never executed a meaningful suite against the change. */
  if (input.verdict !== "pass") return "inconclusive";
  if (input.coverageStatus === "pass") return "covered";
  if (input.coverageStatus === "fail") return "uncovered";
  /* "unknown" (no usable coverage, cross-repo runs) NEVER becomes evidence — the same keystone invariant DecideCoverageService enforces for publish decisions. */
  return "inconclusive";
}

export function foldCurriculum(
  curriculum: Curriculum,
  offered: readonly string[],
  evidence: CurriculumEvidence,
  now: string,
): Curriculum {
  if (evidence === "inconclusive" || offered.length === 0) return curriculum;

  const offeredSet = new Set(offered);
  let changed = false;
  const archetypes = curriculum.archetypes.map((entry) => {
    if (!offeredSet.has(entry.archetype)) return entry;
    changed = true;
    const next: ArchetypeEntry = { ...entry, evaluated: entry.evaluated + 1 };
    if (evidence === "uncovered") return next;
    next.credited += 1;
    if (evidence === "bug") {
      next.promotionCount += 1;
      next.lastPromoted = now;
      if (!next.caughtRealBug) {
        next.caughtRealBug = true;
        next.firstCaughtAt = now;
      }
    }
    return next;
  });

  return changed ? { ...curriculum, archetypes, updatedAt: now } : curriculum;
}

export function archetypeScore(entry: ArchetypeEntry): number {
  return (entry.credited + 1) / (entry.evaluated + 2);
}

export function rankExemplars(curriculum: Curriculum, exemplars: readonly SkillExemplar[]): SkillExemplar[] {
  const byArchetype = new Map(curriculum.archetypes.map((e) => [e.archetype as string, e]));
  const catalogIndex = new Map(BUILT_IN_EXEMPLARS.map((e, i) => [e.id, i]));
  return [...exemplars].sort((a, b) => {
    const ea = byArchetype.get(a.archetype);
    const eb = byArchetype.get(b.archetype);
    const provenA = ea?.caughtRealBug === true ? 0 : 1;
    const provenB = eb?.caughtRealBug === true ? 0 : 1;
    if (provenA !== provenB) return provenA - provenB;
    const scoreA = ea ? archetypeScore(ea) : 0.5;
    const scoreB = eb ? archetypeScore(eb) : 0.5;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const creditA = ea?.credited ?? 0;
    const creditB = eb?.credited ?? 0;
    if (creditA !== creditB) return creditB - creditA;
    return (catalogIndex.get(a.id) ?? 0) - (catalogIndex.get(b.id) ?? 0);
  });
}
