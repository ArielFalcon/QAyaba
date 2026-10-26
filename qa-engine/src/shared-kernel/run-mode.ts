/* Run mode, target, and trigger source — orthogonal axes. Only `diff` runs classifyCommit; the others always generate. */

export type TestTarget = "e2e" | "code";
export type TriggerSource = "webhook" | "manual";
/*
 * Execution mode for a run (taken from the POST body; defaults to "diff").
 * diff       → test the change of the given commit (its blast radius). The
 * commit is classified (Conventional Commits) to decide whether to
 * generate, run regression only, or skip.
 * complete   → analyze the WHOLE repo + existing suite, estimate coverage and
 * importance, persist that analysis, and generate tests for the
 * important UNCOVERED flows (the delta over the existing suite).
 * exhaustive → like complete, but re-evaluate the WHOLE suite from scratch
 * (audit every existing test for correctness/value/necessity and
 * regenerate), not just the delta.
 * manual     → generation focused by user-provided `guidance`.
 * context    → build or refresh the FE↔BE architecture map (e2e/.qa/context.json)
 * from structured sources (routing, OpenAPI, generated clients).
 */
export type RunMode = "diff" | "complete" | "exhaustive" | "manual" | "context";
export const RUN_MODES: readonly RunMode[] = ["diff", "complete", "exhaustive", "manual", "context"] as const;

/**
 * Why a run was started, when it is not a change to test. The mode says what the run does; a purpose says what it is for, and is
 * recorded on the run's persisted note so the history can tell the run apart. It never changes a verdict, a decision or a gate.
 */
export const RUN_PURPOSE = { LOGIN_BOOTSTRAP: "login-bootstrap" } as const;
export type RunPurpose = (typeof RUN_PURPOSE)[keyof typeof RUN_PURPOSE];
