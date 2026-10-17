/* A score: one named, typed judgment of a run, produced by a grader. The wire shape of `GET /runs/:id/evaluation` (docs/observability-design.md §14). */

export const SCORE_DATA_TYPES = ["NUMERIC", "BOOLEAN", "CATEGORICAL"] as const;
export type ScoreDataType = (typeof SCORE_DATA_TYPES)[number];

/* Which way is better. `none` means the value has no better or worse direction (a category, a share). */
export const SCORE_POLARITIES = ["higher_better", "lower_better", "none"] as const;
export type ScorePolarity = (typeof SCORE_POLARITIES)[number];

export const SCORE_SOURCES = ["deterministic", "llm_judge", "human"] as const;
export type ScoreSource = (typeof SCORE_SOURCES)[number];

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
