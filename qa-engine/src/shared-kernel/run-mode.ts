/* Run mode, target, and trigger source — orthogonal axes. Only `diff` runs classifyCommit; the others always generate. */

export type TestTarget = "e2e" | "code";
export type TriggerSource = "webhook" | "manual";
export type RunMode = "diff" | "complete" | "exhaustive" | "manual" | "context";
export const RUN_MODES: readonly RunMode[] = ["diff", "complete", "exhaustive", "manual", "context"] as const;
