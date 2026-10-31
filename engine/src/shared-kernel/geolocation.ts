/*
 * The device location an authoring run works at, as the layers around it share it. A location is a point the browser's
 * Geolocation API reports: the app's durable default, the places it declares by name, and the value one authoring scope
 * (the run's lead, or one flow of a plan) has set. Values are plain numbers and are validated here, at every boundary.
 */

export interface GeoLocation {
  latitude: number;
  longitude: number;
}

/* The most named places one app may declare: the prompt lists them, and a plan may name one per flow. */
export const MAX_PLACES = 12;
export const MAX_PLACE_NAME_CHARS = 40;
/* A place's name is a lowercase slug: the plan and the tool refer to it by exactly this key. */
export const PLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/* The location of one authoring scope: the app's default, where the scope is now, and the places the app declares. */
export type GeolocationScope = "run" | "flow";

export interface GeolocationFacts {
  default: GeoLocation;
  current: GeoLocation;
  places: Readonly<Record<string, GeoLocation>>;
  scope: GeolocationScope;
}

/* A location a caller gave: a point, or the name of a declared place, or something that is neither. */
export interface GeolocationInput {
  place?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

export function normalizeGeoLocation(value: unknown): GeoLocation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { latitude, longitude } = value as { latitude?: unknown; longitude?: unknown };
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined;
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined;
  return { latitude, longitude };
}

/* The key a place is stored under, or undefined when the value is not a name a plan or a tool may use. */
export function placeKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return key.length > 0 && key.length <= MAX_PLACE_NAME_CHARS && PLACE_NAME_PATTERN.test(key) ? key : undefined;
}

/* A declared place by the name a plan or a tool gave, matched without case; undefined when the app does not declare it. */
export function resolvePlace(
  places: Readonly<Record<string, GeoLocation>>,
  asked: unknown,
): { name: string; location: GeoLocation } | undefined {
  const key = placeKey(asked);
  if (key === undefined) return undefined;
  for (const [name, location] of Object.entries(places)) {
    if (name.toLowerCase() !== key) continue;
    const normalized = normalizeGeoLocation(location);
    return normalized ? { name, location: normalized } : undefined;
  }
  return undefined;
}

export function formatGeoLocation(location: GeoLocation): string {
  return `${location.latitude}, ${location.longitude}`;
}
