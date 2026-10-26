/* Defaults that only the settings know: no other module owns them. Kept import-free so any module may read them. */

export const DEFAULT_SELF_REPO = "ArielFalcon/qayaba";
/* How long a cancelled run gets to unwind on shutdown before the process is cut. Fixed, not an environment variable: docker-compose.yml gives the service a longer stop_grace_period so Docker never kills it mid-drain. */
export const DEFAULT_DRAIN_MS = 25_000;
export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
/* The reviewer is a bounded, read-only judge: it never inherits the generator's worst-case budget. */
export const DEFAULT_REVIEWER_TIMEOUT_MS = 6 * 60 * 1000;
/* Strictly less than the shortest run mode's session budget, so a hung session is caught well before the coarse deadline. */
export const DEFAULT_STALL_MS = 180_000;
