import type { RunMode } from "@kernel/run-mode.ts";
import type { GeolocationFacts, GeoLocation } from "@kernel/geolocation.ts";

/**
 * The device location of one run, as the use case sees it: the app's declared default and places, the lead's own value,
 * and one value per flow of a plan. The run opens it after the login and closes it when it ends, however it ends. It is
 * authoring context: the authenticated browser uses it, and a delivered spec pins its own location with setLocation().
 */
export interface GeolocationOpenInput {
  runId: string;
  app: string;
  mode: RunMode;
  /** The run's cancellation: no change is accepted once it fires. */
  signal?: AbortSignal;
}

export interface FlowGeolocationHandle {
  facts(): GeolocationFacts;
  current(): GeoLocation;
  /** Forgets the flow's value; a change from one of its sessions is refused afterwards. */
  close(): void;
}

export interface GeolocationHandle {
  /** The app's declared default: what the suite runs with when a spec sets none. */
  readonly default: GeoLocation;
  /** The lead's scope: the app default until the lead moves it. */
  facts(): GeolocationFacts;
  placeNames(): readonly string[];
  /** Where a session's own scope is now (its flow, or the run's lead), or undefined when the session is not bound to this run. */
  forSession(sessionId: string): GeoLocation | undefined;
  /** Opens a flow's own value, starting where the plan says or where the lead is. Undefined once the run's location is closed. */
  openFlow(delegationId: string, initial?: GeoLocation): FlowGeolocationHandle | undefined;
  /** Revokes every scope and forgets the flows. Never throws. */
  close(): void;
}
