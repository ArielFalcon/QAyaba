/* Run mode, target, and trigger source — orthogonal axes. Only `diff` runs classifyCommit; the others always generate. */

export type TestTarget = "e2e" | "code";
export type TriggerSource = "webhook" | "manual";
export type RunMode = "diff" | "complete" | "exhaustive" | "manual" | "context";
export const RUN_MODES: readonly RunMode[] = ["diff", "complete", "exhaustive", "manual", "context"] as const;

/**
 * Why a run was started, when it is not a change to test. The mode says what the run does; a purpose says what it is for, and is
 * recorded on the run's persisted note so the history can tell the run apart. It never changes a verdict, a decision or a gate.
 */
export const RUN_PURPOSE = { LOGIN_BOOTSTRAP: "login-bootstrap" } as const;
export type RunPurpose = (typeof RUN_PURPOSE)[keyof typeof RUN_PURPOSE];
