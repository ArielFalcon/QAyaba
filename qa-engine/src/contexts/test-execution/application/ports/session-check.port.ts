/*
 * Whether the saved session a run's executions are given is still one the app accepts: the orchestrator's own fact about the session,
 * taken by opening the app with it, never read from how a test's failure page looks (RFC-0015, ADR-0023 row 8).
 */

export type SessionCheck =
  /* The app sent a navigation made with the session to its login page, answered it 401, or showed a password field on a page other than the one asked for. */
  | { state: "lost"; detail: string }
  /* Every page asked for was read and none of them said the session is gone. */
  | { state: "held" }
  /* Nothing could be told: the run holds no saved session to check, or no page asked for could be read. */
  | { state: "unknown"; reason: string };

export interface SessionCheckPort {
  /** Opens each path of the app (a pathname on its own origin) with the saved session as it stands now and judges where the app sent it. */
  check(paths: readonly string[], signal?: AbortSignal): Promise<SessionCheck>;
}
