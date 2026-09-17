/* Canonical pipeline-phase vocabulary for the progress stepper. An unknown raw step is omitted, never invented. */

export type RunStep =
  | "gate" | "classify" | "setup" | "generate" | "validate"
  | "health" | "execute" | "coverage" | "retry" | "decide" | "done";
export const RUN_STEPS: readonly RunStep[] = [
  "gate", "classify", "setup", "generate", "validate",
  "health", "execute", "coverage", "retry", "decide", "done",
] as const;
