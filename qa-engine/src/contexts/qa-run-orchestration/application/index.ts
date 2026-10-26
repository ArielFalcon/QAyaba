/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { NON_LEARNING, OBSERVED_OPERATING } from "../domain/helpers/learning-gates.ts";
export type { ExecutionPort } from "./ports/index.ts";
export type { CleanupPort, PublicationPort, SetupPort, ValidationPort, ValidationRunInfo, WorkspacePort } from "./ports/index.ts";
