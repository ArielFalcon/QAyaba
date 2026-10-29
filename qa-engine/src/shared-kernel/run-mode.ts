/* Run mode, target, and trigger source — orthogonal axes. Only `diff` runs classifyCommit; the others always generate. */

export type TestTarget = "e2e";
export type TriggerSource = "webhook" | "manual";
/*
 * Execution mode for a run (taken from the POST body; defaults to "diff").
 * diff       → test the change of the given commit (its blast radius). The
 * commit is classified (Conventional Commits) to decide whether to
 * generate, run regression only, or skip.
 * manual     → generation focused by user-provided `guidance`.
 * context    → build or refresh the FE↔BE architecture map (e2e/.qa/context.json)
 * from structured sources (routing, OpenAPI, generated clients).
 */
export type RunMode = "diff" | "manual" | "context";
export const RUN_MODES: readonly RunMode[] = ["diff", "manual", "context"] as const;

/* Modes that were removed. A request that names one is refused, never run as another mode. */
export const RETIRED_RUN_MODES: readonly string[] = ["complete", "exhaustive"] as const;

/**
 * Why a run was started, when it is not a change to test. The mode says what the run does; a purpose says what it is for, and is
 * recorded on the run's persisted note so the history can tell the run apart. It never changes a verdict, a decision or a gate.
 */
export const RUN_PURPOSE = { LOGIN_BOOTSTRAP: "login-bootstrap" } as const;
export type RunPurpose = (typeof RUN_PURPOSE)[keyof typeof RUN_PURPOSE];
