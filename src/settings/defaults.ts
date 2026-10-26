/* Defaults that only the settings know: no other module owns them. Kept import-free so any module may read them. */

export const DEFAULT_SELF_REPO = "ArielFalcon/qayaba";
export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
/* The reviewer is a bounded, read-only judge: it never inherits the generator's worst-case budget. */
export const DEFAULT_REVIEWER_TIMEOUT_MS = 6 * 60 * 1000;
/* Strictly less than the shortest run mode's session budget, so a hung session is caught well before the coarse deadline. */
export const DEFAULT_STALL_MS = 180_000;
