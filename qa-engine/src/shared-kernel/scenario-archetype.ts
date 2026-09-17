/* Canonical scenario-archetype vocabulary — a kind of test scenario, not a shape of code change (that is StructuralPattern). */

export type ScenarioArchetype =
  | "happy-path"
  | "empty-state"
  | "boundary-value"
  | "invalid-input"
  | "re-query-after-mutation"
  | "concurrent-update"
  | "permission-denied"
  | "network-error"
  | "loading-state"
  | "stale-data";

export const ALL_ARCHETYPES: readonly ScenarioArchetype[] = [
  "happy-path", "empty-state", "boundary-value", "invalid-input",
  "re-query-after-mutation", "concurrent-update", "permission-denied",
  "network-error", "loading-state", "stale-data",
] as const;
