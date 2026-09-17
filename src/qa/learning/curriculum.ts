/* Control-plane re-export; canonical curriculum lives in qa-engine cross-run-learning. */
export type { Curriculum, ArchetypeEntry, CurriculumEvidence } from "@contexts/cross-run-learning/domain/curriculum";
export { initCurriculum, normalizeCurriculum, classifyEvidence, foldCurriculum, archetypeScore, rankExemplars } from "@contexts/cross-run-learning/domain/curriculum";
export { ALL_ARCHETYPES, type ScenarioArchetype } from "@kernel/scenario-archetype";
