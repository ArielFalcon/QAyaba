/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { detectArchetype } from "../domain/distill-rule.ts";
export { renderLearnedRules, renderLearnedRulesForReviewer } from "./render-learned-rules.ts";
export { ERROR_CLASS, ERROR_CLASSES, GRAVE_TAGS, errorClassFromCorrections, errorClassFromVerdict, resolveErrorClass } from "./../domain/error-class.ts";
export type { ErrorClass } from "./../domain/error-class.ts";
export { NON_LEARNING, OBSERVED_OPERATING, learningGates, observesOperatingSignal } from "./../domain/learning-gates.ts";
export type { CurriculumPort } from "./ports/curriculum.port.ts";
export type { LearningQuarantinePort } from "./ports/learning-quarantine.port.ts";
export { FoldRunOutcome } from "./fold-run-outcome.use-case.ts";
export type { LearningRow, LearningStore, ScorecardEntryInput } from "./ports/learning-store.port.ts";
export type { LearningRepositoryPort } from "./ports/learning-repository.port.ts";
export type { LearningPort } from "./ports/learning.port.ts";
export type { ProcessAuditPort } from "./ports/process-audit.port.ts";
export type { ReflectorPort } from "./ports/reflector.port.ts";
export { MAX_SELECTED_EXEMPLARS } from "../domain/curriculum-model.ts";
export type { CurriculumFoldInput } from "../domain/curriculum-model.ts";
export type { LearningRule, ReflectionInput, RuleStatus } from "../domain/learning-repository.ts";
export type { RelevanceBias } from "../domain/learning.ts";
