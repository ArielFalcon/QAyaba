import type { BoundaryProfile } from "../../domain/index.ts";

/** Reads and validates an app's declared boundary conventions from config (Invariant #1: every app-specific pattern comes from config, never a literal in the engine core). NEVER throws: a missing/malformed config degrades to an empty array (fail-open). */
export interface BoundaryProfileProviderPort {
  forApp(appName: string): Promise<BoundaryProfile[]>;
}
