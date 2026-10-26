/* Canonical pipeline-phase vocabulary for the progress stepper. An unknown raw step is omitted, never invented. */

export type RunStep =
  | "gate" | "classify" | "setup" | "generate" | "validate"
  | "health" | "execute" | "coverage" | "retry" | "decide" | "done";
export const RUN_STEPS: readonly RunStep[] = [
  "gate", "classify", "setup", "generate", "validate",
  "health", "execute", "coverage", "retry", "decide", "done",
] as const;

/* The `onStep("generate", …)` detail marking the pre-generation-grounding
   sub-step (run-qa.use-case.ts's grounding call). The coarse efficiency
   classifier (domain/coarse-run-efficiency.ts) uses this exact
   string to window grounding activity out of the first-pass/whole-run
   metrics — keep both call sites in sync through this one constant. */
export const PRE_GENERATION_GROUNDING_STEP_DETAIL = "pre-generation grounding";

/** The run's stages in pipeline order. The order decides which entered phase counts as the furthest one. */
export const RUN_PHASES = [
  "gate",
  "workspace",
  "classify",
  "setup",
  "ground",
  "generate",
  "validate",
  "health",
  "execute",
  "fix_loop",
  "coverage",
  "review",
  "decide",
  "publish",
  "learn",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];
