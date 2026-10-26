/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { classifyRange } from "../domain/commit-classification.ts";
export type { ChangeAnalysisPort } from "./ports/change-analysis.port.ts";
export type { VcsReadPort } from "./ports/vcs-read.port.ts";
