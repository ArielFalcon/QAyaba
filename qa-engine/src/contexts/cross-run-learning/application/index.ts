/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { NON_LEARNING, OBSERVED_OPERATING, learningGates, observesOperatingSignal } from "../domain/learning-gates.ts";
export type { ProcessAuditPort } from "./ports/process-audit.port.ts";
