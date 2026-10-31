/* Canonical pipeline-phase vocabulary for the progress stepper. An unknown raw step is omitted, never invented. */

export const RUN_STEPS = [
  "gate", "classify", "setup", "generate", "validate",
  "health", "execute", "coverage", "retry", "decide", "done",
] as const;
export type RunStep = (typeof RUN_STEPS)[number];

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

/**
 * The stretches of a run's wall time that lie outside every phase, each a `qayaba.stage.<name>` child span of the run's root, in the
 * order they happen. A phase is what the engine's cursor says the run is doing; a stage is the work around it that no phase holds:
 * the shell's preparation before the engine starts, the sandbox scope the engine opens before its first phase and closes after its
 * last, and the teardown between the last phase and that close. A reader accounts for a run's time as phases + stages + what no span explains.
 */
export const RUN_STAGES = [
  "onboarding_wait",
  "context_map",
  "config",
  "engine_build",
  "sandbox_open",
  "teardown",
  "sandbox_close",
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

export const STAGE_SPAN_PREFIX = "qayaba.stage.";
export const stageSpanName = (stage: RunStage): string => `${STAGE_SPAN_PREFIX}${stage}`;
