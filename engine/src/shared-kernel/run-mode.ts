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
export const RUN_MODES = ["diff", "manual", "context"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/* Reads the mode a request names, for every entry point: none means "diff"; anything that is not a run mode (a removed mode
   included) is refused with the reason, never run as another mode. */
export function parseRunMode(value: unknown): { ok: true; mode: RunMode } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, mode: "diff" };
  if (typeof value === "string" && (RUN_MODES as readonly string[]).includes(value)) return { ok: true, mode: value as RunMode };
  return { ok: false, error: `${JSON.stringify(value)} is not a run mode; use one of ${RUN_MODES.join(", ")}` };
}

/**
 * Why a run was started, when it is not a change to test. The mode says what the run does; a purpose says what it is for, and is
 * recorded on the run's persisted note so the history can tell the run apart. It never changes a verdict, a decision or a gate.
 */
export const RUN_PURPOSE = { LOGIN_BOOTSTRAP: "login-bootstrap" } as const;
export type RunPurpose = (typeof RUN_PURPOSE)[keyof typeof RUN_PURPOSE];
