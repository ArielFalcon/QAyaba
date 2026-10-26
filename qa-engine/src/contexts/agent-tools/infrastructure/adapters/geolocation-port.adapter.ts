/*
 * GeolocationPort → the location of one run. Opened inside the run (so the run's sandbox scope and its secret scope are the
 * ones active), it keeps the app's default and places, the lead's own value and one value per flow, and registers the state
 * where the authoring agents' sessions will find it (GeolocationRegistry). A flow starts where its plan says or where the
 * lead is; a change from a session moves only that session's scope. The value is authoring context: the authenticated browser
 * uses it, and a delivered spec pins its own location with setLocation().
 */

import type { GeoLocation, GeolocationFacts } from "@kernel/geolocation.ts";
import type { FlowGeolocationHandle, GeolocationHandle, GeolocationOpenInput } from "../../domain/geolocation.ts";
import type { GeolocationPort } from "../../application/ports/geolocation.port.ts";
import { RunGeolocation } from "../../domain/run-geolocation.ts";
import type { GeolocationRegistry, LiveGeolocation } from "../geolocation-registry.ts";

export interface GeolocationPortAdapterDeps {
  registry: GeolocationRegistry;
  /* The app's own setting (qa.geolocation), already validated. */
  setting: { default: GeoLocation; places: Readonly<Record<string, GeoLocation>> };
}

export class GeolocationPortAdapter implements GeolocationPort {
  constructor(private readonly deps: GeolocationPortAdapterDeps) {}

  async open(input: GeolocationOpenInput): Promise<GeolocationHandle | undefined> {
    const state = new RunGeolocation(this.deps.setting);
    const live: LiveGeolocation = {
      runId: input.runId,
      state,
      set: (delegationId, change) => state.set(delegationId, change),
    };
    this.deps.registry.register(live);
    let closed = false;
    return {
      default: state.defaultLocation,
      facts: () => state.facts(),
      placeNames: () => state.placeNames(),
      forSession: (sessionId) => {
        const bound = this.deps.registry.find(sessionId);
        if (bound === undefined || bound.live.runId !== input.runId) return undefined;
        return state.currentFor(bound.delegationId);
      },
      openFlow: (delegationId, initial) => {
        if (closed) return undefined;
        state.openFlow(delegationId, initial);
        const facts = (): GeolocationFacts => state.flowFacts(delegationId) ?? { ...state.facts(), scope: "flow" };
        const handle: FlowGeolocationHandle = {
          facts,
          current: () => facts().current,
          close: () => state.closeFlow(delegationId),
        };
        return handle;
      },
      close: () => {
        if (closed) return;
        closed = true;
        state.close();
        this.deps.registry.unregister(input.runId);
      },
    };
  }
}
