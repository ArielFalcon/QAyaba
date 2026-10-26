import type { RunMode, RunPurpose } from "@kernel/run-mode.ts";
import type { AgentBrowserGateSignal, AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeoLocation } from "@kernel/geolocation.ts";

/**
 * The authenticated browser of one run, as the use case sees it: the right of the authoring agents to read DEV through the
 * session the run signed in with, without ever holding it. The run opens it after the login and closes it when it ends,
 * however it ends.
 */
export interface AgentBrowserOpenInput {
  runId: string;
  app: string;
  mode: RunMode;
  purpose?: RunPurpose;
  /** The suite directory of the run's working copy: where a renewed login is prepared for. */
  specDir: string;
  /** The run's own choice, when it makes one (an A/B arm): overrides the app's setting. */
  enabled?: boolean;
  /** The run's cancellation: a call in flight when it fires is stopped. */
  signal?: AbortSignal;
  /** The app's declared location, when it declares one: the browser opens at it, and each session's own scope may move it. Absent: the browser is not given a location. */
  geolocation?: { default: GeoLocation; forSession(sessionId: string): GeoLocation | undefined };
}
export interface AgentBrowserHandle {
  /** What the generator's prompt states about the tools. */
  limits: AgentBrowserLimits;
  /** Gives a flow of a plan the calls its sidekick may make out of the run's, before the sidekick's session opens. */
  grantShare(delegationId: string, calls: number): void;
  signals(): AgentBrowserGateSignal;
  /** Revokes the right, stops the browser. Never throws. */
  close(): Promise<void>;
}
export interface AgentBrowserPort {
  /** Resolves undefined when this run is not granted the browser (disabled, another runtime, no saved session to use). */
  open(input: AgentBrowserOpenInput): Promise<AgentBrowserHandle | undefined>;
}
