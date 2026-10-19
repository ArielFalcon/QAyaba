/*
 * Where a grounding source came from and how fresh it was (docs/adr/0001-grounding-telemetry-quality.md D5).
 * Spans carry the fields; metrics use only the closed `source`/`reason`/`outcome` labels, never a path or a sha.
 */

export interface ContextProvenance {
  /* The effective location: db:context_maps, file:e2e/.qa/context.json, live:dev, mirror:stitcher,
   * graph:codebase-memory, db:learning_rules, db:curriculum or agent:explorer-brief. */
  location?: string;
  /* When the source was captured, ISO-8601. */
  capturedAt?: string;
  /* The SHA the source was built from, when it has one. */
  capturedSha?: string;
  ageMs?: number;
  /* Routes+operations+links+flows, pages, claims, lines, rules or exemplars. */
  resultCount?: number;
  stale?: boolean;
  staleReason?: string;
  recapture?: string;
  /* The change-relevant DOM differed between two captures of the same page. */
  domChanged?: boolean;
}

/* The map's 14-day age bound: a map older than this is stale even when the SHA still matches. */
export const CONTEXT_MAP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/* The minimum interval between two off-path rebuild requests for the same app. */
export const CONTEXT_HEAL_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/* The number of entries a map supplies, for the provenance record. Every section is read as a list; a malformed one counts zero. */
export function contextMapResultCount(map: {
  routes?: readonly unknown[];
  api?: readonly unknown[];
  feBe?: readonly unknown[];
  flows?: readonly unknown[];
}): number {
  return (map.routes?.length ?? 0) + (map.api?.length ?? 0) + (map.feBe?.length ?? 0) + (map.flows?.length ?? 0);
}
