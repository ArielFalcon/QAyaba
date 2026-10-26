/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { LearningRepositoryPort, ProcessAuditPort, ReflectionInput, ReflectorPort, RuleStatus } from "./ports/index.ts";
export { detectArchetype } from "../domain/distill-rule.ts";
export type { LearningPort, RelevanceBias, RetrievedRule } from "./ports/learning.port.ts";
export { MAX_SELECTED_EXEMPLARS } from "./ports/curriculum.port.ts";
export type { CurriculumFoldInput, CurriculumPort, SelectedExemplar } from "./ports/curriculum.port.ts";
export { renderLearnedRules, renderLearnedRulesForReviewer } from "./render-learned-rules.ts";
