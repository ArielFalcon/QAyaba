/* Sole engine selector. PIPELINE_ENGINE is accepted but ignored; warn once if an operator still sets it to a value that has no implementation. */
export const PIPELINE_ENGINE = "PIPELINE_ENGINE" as const;
export type EngineChoice = "rewritten";

let warnedLegacyRequested = false;

export function selectEngine(env: Record<string, string | undefined>): EngineChoice {
  if (env[PIPELINE_ENGINE] === "legacy" && !warnedLegacyRequested) {
    warnedLegacyRequested = true;
    console.warn(
      "[qa] PIPELINE_ENGINE=legacy was requested but that engine no longer exists — running the current engine instead.",
    );
  }
  return "rewritten";
}
