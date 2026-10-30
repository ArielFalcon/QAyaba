/* A score: one named, typed judgment of a run, produced by a grader. The wire shape of `GET /runs/:id/evaluation` (docs/observability-design.md §14). */

export const SCORE_DATA_TYPES = ["NUMERIC", "BOOLEAN", "CATEGORICAL"] as const;
export type ScoreDataType = (typeof SCORE_DATA_TYPES)[number];

/* Which way is better. `none` means the value has no better or worse direction (a category, a share). */
export const SCORE_POLARITIES = ["higher_better", "lower_better", "none"] as const;
export type ScorePolarity = (typeof SCORE_POLARITIES)[number];

export const SCORE_SOURCES = ["deterministic", "human"] as const;
export type ScoreSource = (typeof SCORE_SOURCES)[number];

/* A stored source the contract names; the LLM judges are gone, and a row they left names a source this is false for. */
export function isScoreSource(source: string): source is ScoreSource {
  return (SCORE_SOURCES as readonly string[]).includes(source);
}

export type ScoreValue = number | boolean | string;

export interface Score {
  /* A catalog base name, or `<base>.<suffix>` for a family. */
  name: string;
  value: ScoreValue;
  dataType: ScoreDataType;
  polarity: ScorePolarity;
  source: ScoreSource;
  /* Names, types, ranges and polarities are frozen per grader version; scores of different versions are not comparable. */
  graderVersion: string;
  comment?: string;
  /* The span the score is about, when it is about one. */
  observationId?: string;
}

/* What a grader returns: the catalog supplies everything but the value and the comment. */
export interface RawScore {
  name: string;
  value: ScoreValue;
  comment?: string;
  observationId?: string;
}
