/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { NON_LEARNING, OBSERVED_OPERATING, learningGates, observesOperatingSignal } from "../domain/learning-gates.ts";
export type { CurriculumPort } from "./ports/curriculum.port.ts";
export type { ProcessAuditPort } from "./ports/process-audit.port.ts";
export { CURRICULUM_CORRUPT, MAX_SELECTED_EXEMPLARS } from "../domain/curriculum-model.ts";
export type { CurriculumFoldInput } from "../domain/curriculum-model.ts";
export { foldCurriculum, initCurriculum } from "../domain/curriculum.ts";
export type { Curriculum } from "../domain/curriculum.ts";
