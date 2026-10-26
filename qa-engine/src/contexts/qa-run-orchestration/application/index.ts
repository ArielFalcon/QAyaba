/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { MAX_SELECTED_EXEMPLARS } from "./ports/index.ts";
export type { CurriculumFoldInput, CurriculumPort, SelectedExemplar } from "./ports/index.ts";
export { NON_LEARNING, OBSERVED_OPERATING } from "../domain/helpers/learning-gates.ts";
export type { CleanupPort, ExecutionPort } from "./ports/index.ts";
