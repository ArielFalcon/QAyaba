/** What the run knows that a validation may report on. */
export interface ValidationRunInfo {
  /** The specs (relative to the suite directory) this run has delivered so far: written by its generator or a sidekick, as reported by them. */
  deliveredSpecs?: readonly string[];
}
