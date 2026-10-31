import type { GeolocationHandle, GeolocationOpenInput } from "../../domain/geolocation.ts";

export interface GeolocationPort {
  /** Resolves undefined when the app declares no location: no tool, no section and no value to inject. */
  open(input: GeolocationOpenInput): Promise<GeolocationHandle | undefined>;
}
