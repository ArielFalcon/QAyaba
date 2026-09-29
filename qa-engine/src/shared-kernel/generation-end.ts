/* How a generation attempt ended, as the one vocabulary generation (which classifies it) and run orchestration (which maps it to a run outcome) share. Constants only: the classification and its mapping live in their own contexts. */

export const GENERATION_END = {
  /** The generator wrote specs; the run continues. */
  DELIVERED: "delivered",
  /** No specs, and the generator said why: a decision, not silence. */
  DECLARED_NOOP: "declared-noop",
  /** No specs, and the agent ran out of steps. */
  EXHAUSTED: "exhausted",
  /** A verdict came back with no specs and no decision, even after the one repair. */
  UNDECIDED_EMPTY: "undecided-empty",
  /** No verdict could be read from the output, even after the one repair. */
  NO_VERDICT: "no-verdict",
} as const;

export type GenerationEndKind = (typeof GENERATION_END)[keyof typeof GENERATION_END];
