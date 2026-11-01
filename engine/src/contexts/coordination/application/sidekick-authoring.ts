/*
 * With what a sidekick may author a flow. A sidekick has no saved session, so against an app with a login its own browser would
 * author against the login wall and the suite would then run signed in: it is given either the orchestrator's authenticated
 * browser, which reads DEV as the test account without ever holding the session, or run_spec alone, or it stays out. An app
 * with no login needs no session, and the plain browser the sidekick holds is enough; that browser is one process shared by
 * every session, so such flows are authored one at a time. Pure.
 */

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
  if (!facts.hasLogin) return { mode: SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER, maxParallel: 1 };
  if (facts.browserGranted) return { mode: SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER, maxParallel: MAX_SESSION_PAGES };
  if (facts.runSpecGranted) return { mode: SIDEKICK_AUTHORING.RUN_SPEC_ONLY };
  return { mode: SIDEKICK_AUTHORING.EXCLUDED, reason: "the app has a login and the run was granted neither the authenticated browser nor run_spec, so a sidekick would author against the login wall" };
}

/* The tool families the orchestrator decides for a sidekick, as the brief names them. The roster's own tools (reading, searching, editing) are not the orchestrator's to grant. */
export const SIDEKICK_CAPABILITY = {
  RUN_SPEC: "run_spec",
  AUTHBROWSER: "authbrowser",
  SET_GEOLOCATION: "set_geolocation",
  PLAYWRIGHT: "playwright",
} as const;
export type SidekickCapability = (typeof SIDEKICK_CAPABILITY)[keyof typeof SIDEKICK_CAPABILITY];

/* What the orchestrator holds of one flow's tools. */
export interface FlowGrantFacts {
  /* The flow was given a run_spec loop. */
  loop: boolean;
  /* The run holds the authenticated browser. */
  agentBrowser: boolean;
  /* The flow has an authoring location to move. */
  geolocation: boolean;
}

export interface SidekickGrants {
  readonly granted: readonly SidekickCapability[];
  readonly withheld: readonly SidekickCapability[];
  /* The tools the sidekick's prompts are denied, whatever its configuration allows. */
  readonly denyTools: readonly string[];
}

/* The one computation of what a flow's sidekick is granted: the brief states `granted` and `withheld`, and the session denies `denyTools`. */
export function sidekickGrants(mode: SidekickAuthoringMode, flow: FlowGrantFacts): SidekickGrants {
  const held: Readonly<Record<SidekickCapability, boolean>> = {
    [SIDEKICK_CAPABILITY.RUN_SPEC]: flow.loop,
    [SIDEKICK_CAPABILITY.AUTHBROWSER]: mode === SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER && flow.agentBrowser,
    [SIDEKICK_CAPABILITY.SET_GEOLOCATION]: flow.geolocation,
    [SIDEKICK_CAPABILITY.PLAYWRIGHT]: mode === SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER,
  };
  const capabilities = Object.values(SIDEKICK_CAPABILITY);
  return {
    granted: capabilities.filter((capability) => held[capability]),
    withheld: capabilities.filter((capability) => !held[capability]),
    denyTools: [
      /* Its symbol edits write wherever the server's project points, which is not the workspace. */
      "serena*",
      ...(held[SIDEKICK_CAPABILITY.PLAYWRIGHT] ? [] : ["playwright*"]),
      ...(held[SIDEKICK_CAPABILITY.RUN_SPEC] ? [] : ["run_spec"]),
    ],
  };
}
