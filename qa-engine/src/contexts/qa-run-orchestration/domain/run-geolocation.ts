/*
 * The location one run works at: the app's declared default and places, the lead's own value, and one value per flow of a
 * plan. A flow inherits the lead's location when it opens and may change only its own; the lead changes only the run's.
 * Pure: no clock, no file, no process. The runtime state is authoring context; a delivered spec pins its own location.
 */

import {
  MAX_PLACES,
  normalizeGeoLocation,
  placeKey,
  resolvePlace,
  type GeoLocation,
  type GeolocationFacts,
  type GeolocationInput,
} from "@kernel/geolocation.ts";

export const GEOLOCATION_REFUSAL = {
  INVALID_LOCATION: "invalid-location",
  UNKNOWN_PLACE: "unknown-place",
  UNKNOWN_SCOPE: "unknown-scope",
  CLOSED: "closed",
} as const;

export type GeolocationRefusalCode = (typeof GEOLOCATION_REFUSAL)[keyof typeof GEOLOCATION_REFUSAL];

export interface GeolocationRefusal {
  ok: false;
  code: GeolocationRefusalCode;
  message: string;
}

export interface GeolocationChange {
  ok: true;
  location: GeoLocation;
  scope: "run" | "flow";
  /* The declared place the location came from, when the caller named one. */
  place?: string;
}

export type GeolocationResult = GeolocationChange | GeolocationRefusal;

export interface RunGeolocationInit {
  default: GeoLocation;
  places?: Readonly<Record<string, GeoLocation>>;
}

function refusal(code: GeolocationRefusalCode, message: string): GeolocationRefusal {
  return { ok: false, code, message };
}

export class RunGeolocation {
  private readonly places_: Readonly<Record<string, GeoLocation>>;
  private readonly default_: GeoLocation;
  private lead: GeoLocation;
  private readonly flows = new Map<string, GeoLocation>();
  private closed = false;

  constructor(init: RunGeolocationInit) {
    const fallback = normalizeGeoLocation(init.default);
    if (!fallback) throw new Error("RunGeolocation requires a valid default location");
    this.default_ = fallback;
    this.lead = fallback;
    const places: Record<string, GeoLocation> = {};
    for (const [key, value] of Object.entries(init.places ?? {})) {
      const name = placeKey(key);
      const location = normalizeGeoLocation(value);
      if (name === undefined || !location) throw new Error(`RunGeolocation: invalid place ${JSON.stringify(key)}`);
      places[name] = location;
    }
    if (Object.keys(places).length > MAX_PLACES) throw new Error(`RunGeolocation: at most ${MAX_PLACES} places are allowed`);
    this.places_ = places;
  }

  get defaultLocation(): GeoLocation {
    return this.default_;
  }

  get places(): Readonly<Record<string, GeoLocation>> {
    return this.places_;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /* The names of the declared places, sorted so a prompt and a plan read the same list every time. */
  placeNames(): readonly string[] {
    return Object.keys(this.places_).sort();
  }

  /* The lead's own location: the app's default until the lead sets another. */
  facts(): GeolocationFacts {
    return { default: this.default_, current: this.lead, places: this.places_, scope: "run" };
  }

  /* The location of one flow, once opened; undefined when the flow is not open (or the run has ended). */
  flowFacts(delegationId: string): GeolocationFacts | undefined {
    const current = this.flows.get(delegationId);
    return current === undefined ? undefined : { default: this.default_, current, places: this.places_, scope: "flow" };
  }

  currentFor(delegationId: string | undefined): GeoLocation | undefined {
    if (this.closed) return undefined;
    return delegationId === undefined ? this.lead : this.flows.get(delegationId);
  }

  /* Opens a flow's own value. It starts where the plan says, or where the lead is when the flow is opened. */
  openFlow(delegationId: string, initial?: GeoLocation): void {
    if (this.closed || this.flows.has(delegationId)) return;
    this.flows.set(delegationId, normalizeGeoLocation(initial) ?? this.lead);
  }

  closeFlow(delegationId: string): void {
    this.flows.delete(delegationId);
  }

  /* Where the caller's scope moves to. The lead's value is the run's, a sidekick's is its flow's, and nothing else moves. */
  set(delegationId: string | undefined, input: GeolocationInput): GeolocationResult {
    if (this.closed) return refusal(GEOLOCATION_REFUSAL.CLOSED, "the location of this run is no longer available: the run has ended");
    let target: GeoLocation | undefined;
    let place: string | undefined;
    if (input.place !== undefined && input.place !== null && input.place !== "") {
      const resolved = resolvePlace(this.places_, input.place);
      if (!resolved) {
        const names = this.placeNames();
        return refusal(
          GEOLOCATION_REFUSAL.UNKNOWN_PLACE,
          `the app declares no place named ${JSON.stringify(String(input.place)).slice(0, 80)}${names.length > 0 ? `; it declares: ${names.join(", ")}` : ""}`,
        );
      }
      target = resolved.location;
      place = resolved.name;
    } else {
      target = normalizeGeoLocation({ latitude: input.latitude, longitude: input.longitude });
      if (!target) {
        return refusal(GEOLOCATION_REFUSAL.INVALID_LOCATION, "give a place the app declares, or a latitude from -90 to 90 and a longitude from -180 to 180");
      }
    }
    if (delegationId === undefined) {
      this.lead = target;
      return { ok: true, location: target, scope: "run", ...(place !== undefined ? { place } : {}) };
    }
    if (!this.flows.has(delegationId)) {
      return refusal(GEOLOCATION_REFUSAL.UNKNOWN_SCOPE, "this flow is no longer being authored; its location cannot be changed");
    }
    this.flows.set(delegationId, target);
    return { ok: true, location: target, scope: "flow", ...(place !== undefined ? { place } : {}) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flows.clear();
  }
}
