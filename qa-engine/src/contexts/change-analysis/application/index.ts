/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { VcsReadPort } from "./ports/index.ts";
export { classifyRange } from "../domain/commit-classification.ts";
export { LanguageRegistry } from "../domain/language-id.ts";
export type { ChangeAnalysisPort } from "./ports/change-analysis.port.ts";
export type { StructuralSignalPort, StructuralSignalResult } from "./ports/structural-signal.port.ts";
