/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { LearningRepositoryPort, ProcessAuditPort, ReflectionInput, ReflectorPort, RuleStatus } from "./ports/index.ts";
export { detectArchetype } from "../domain/distill-rule.ts";
