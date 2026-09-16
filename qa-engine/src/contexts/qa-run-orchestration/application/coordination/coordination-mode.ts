// Feature flag for the coordination program. Rollback is this mode, never PIPELINE_ENGINE=legacy.
// Fase 1 only constructs a live port for "off". shadow/active are named so later phases can
// resolve them without inventing a second flag.
export const COORDINATION_MODES = ["off", "shadow", "active"] as const;
export type CoordinationMode = (typeof COORDINATION_MODES)[number];

export function resolveCoordinationMode(raw: string | undefined): CoordinationMode {
  if (raw === undefined || raw === "" || raw === "off") return "off";
  if (raw === "shadow" || raw === "active") return raw;
  throw new Error(`unknown coordination.mode: ${raw}`);
}
