/*
 * With what a sidekick may author a flow. A sidekick has no saved session, so against an app with a login its own browser would
 * author against the login wall and the suite would then run signed in: it is given either the orchestrator's authenticated
 * browser, which reads DEV as the test account without ever holding the session, or run_spec alone, or it stays out. An app
 * with no login needs no session, and the plain browser the sidekick holds is enough; that browser is one process shared by
 * every session, so such flows are authored one at a time. A sidekick on a runtime that cannot call a tool cannot use
 * run_spec or the authenticated browser at all and is left out. Pure.
 */

import type { AgentProvider } from "@kernel/agent-role.ts";
import { MAX_SESSION_PAGES } from "@kernel/agent-browser.ts";

export const SIDEKICK_AUTHORING = {
  AUTHENTICATED_BROWSER: "authenticated-browser",
  RUN_SPEC_ONLY: "run-spec-only",
  UNAUTHENTICATED_BROWSER: "unauthenticated-browser",
  EXCLUDED: "excluded",
} as const;
export type SidekickAuthoringMode = (typeof SIDEKICK_AUTHORING)[keyof typeof SIDEKICK_AUTHORING];

export interface AuthoringFacts {
  /* The app declares a login. */
  hasLogin: boolean;
  /* The runtime the sidekick role is assigned to, when the host can say. */
  provider: AgentProvider | undefined;
  /* The run was granted run_spec, and the authenticated browser. */
  runSpecGranted: boolean;
  browserGranted: boolean;
}

export interface SidekickAuthoringDecision {
  mode: SidekickAuthoringMode;
  /* A cap on the flows authored at once, when the mode needs one. */
  maxParallel?: number;
  /* Why the sidekicks stay out, for the log. */
  reason?: string;
}

export function sidekickAuthoring(facts: AuthoringFacts): SidekickAuthoringDecision {
  if (facts.provider !== "opencode") {
    return { mode: SIDEKICK_AUTHORING.EXCLUDED, reason: `the sidekick role runs on ${facts.provider ?? "a runtime the host cannot name"}, and only OpenCode can call run_spec and the authenticated browser` };
  }
  if (!facts.hasLogin) return { mode: SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER, maxParallel: 1 };
  if (facts.browserGranted) return { mode: SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER, maxParallel: MAX_SESSION_PAGES };
  if (facts.runSpecGranted) return { mode: SIDEKICK_AUTHORING.RUN_SPEC_ONLY };
  return { mode: SIDEKICK_AUTHORING.EXCLUDED, reason: "the app has a login and the run was granted neither the authenticated browser nor run_spec, so a sidekick would author against the login wall" };
}

/* The tools a sidekick's prompts are denied, whatever its configuration allows. */
export function sidekickDeniedTools(mode: SidekickAuthoringMode, flowHasLoop: boolean): string[] {
  return [
    /* Its symbol edits write wherever the server's project points, which is not the workspace. */
    "serena*",
    ...(mode === SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER ? [] : ["playwright*"]),
    ...(flowHasLoop ? [] : ["run_spec"]),
  ];
}
