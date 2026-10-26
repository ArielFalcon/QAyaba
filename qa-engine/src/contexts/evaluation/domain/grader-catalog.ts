/*
 * The single source for score names, types, ranges, categories, polarity and suffix families. Graders build their scores from it,
 * and `GET /evaluations/catalog` is this list: the two cannot disagree. A family entry (`context_utilization`,
 * `step_intent_mix`) declares a closed set of suffixes, and `<base>.<suffix>` inherits everything from its base.
 *
 * `state: "pending"` entries are declared so consumers can plan for them, but no grader emits them yet: they need data the
 * pipeline does not record (referenced context ids, spec snapshots, the no-op kind, strict-mode failure counts, campaign re-runs).
 */

import { RUN_PHASES } from "@kernel/run-step";
import type { RawScore, Score, ScoreDataType, ScorePolarity } from "./score.ts";

/* The longest comment a score carries: it is read by people and travels to a sink, never a free-form log. */
export const MAX_SCORE_COMMENT_CHARS = 500;

export const GRADER_VERSION = "2";

export const STEP_INTENTS = ["auth", "explore", "write_spec", "run_spec", "review", "other"] as const;
export type StepIntent = (typeof STEP_INTENTS)[number];

export const CONTEXT_SOURCES = ["route", "dom", "op", "file"] as const;
export const CONTEXT_FOCUSED_SOURCES = ["route", "dom", "op"] as const;

export const COVERAGE_CLASSES = ["pass", "fail", "unknown"] as const;

export interface ScoreSpec {
  name: string;
  dataType: ScoreDataType;
  polarity: ScorePolarity;
  range?: { min: number; max?: number };
  categories?: readonly string[];
  suffixes?: readonly string[];
  graderVersion: string;
  state: "graded" | "pending";
}

const spec = (s: Omit<ScoreSpec, "graderVersion" | "state"> & { state?: ScoreSpec["state"] }): ScoreSpec => ({ graderVersion: GRADER_VERSION, state: "graded", ...s });
const UNIT = { min: 0, max: 1 } as const;

export const GRADER_CATALOG: readonly ScoreSpec[] = [
  spec({ name: "empty_output_guard", dataType: "BOOLEAN", polarity: "higher_better" }),
  spec({ name: "furthest_phase", dataType: "CATEGORICAL", polarity: "none", categories: RUN_PHASES }),
  spec({ name: "spec_validity_rate", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "spec_pass_rate", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "selector_stability", dataType: "NUMERIC", polarity: "higher_better", range: UNIT, state: "pending" }),
  spec({ name: "budget_exhaustion", dataType: "CATEGORICAL", polarity: "none" }),
  spec({ name: "step_intent_mix", dataType: "NUMERIC", polarity: "none", range: UNIT, suffixes: STEP_INTENTS }),
  spec({ name: "auth_overhead", dataType: "NUMERIC", polarity: "lower_better", range: UNIT }),
  spec({ name: "approval_consistent", dataType: "BOOLEAN", polarity: "higher_better" }),
  spec({ name: "context_utilization", dataType: "NUMERIC", polarity: "higher_better", range: UNIT, suffixes: CONTEXT_SOURCES }),
  spec({ name: "context_utilization_focused", dataType: "NUMERIC", polarity: "higher_better", range: UNIT, suffixes: CONTEXT_FOCUSED_SOURCES }),
  spec({ name: "context_complete", dataType: "BOOLEAN", polarity: "higher_better" }),
  spec({ name: "context_fresh", dataType: "BOOLEAN", polarity: "higher_better" }),
  spec({ name: "noop_consistent", dataType: "BOOLEAN", polarity: "higher_better" }),
  spec({ name: "change_coverage", dataType: "CATEGORICAL", polarity: "none", categories: COVERAGE_CLASSES }),
  spec({ name: "mutation_value", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "infra_error", dataType: "CATEGORICAL", polarity: "none" }),
  spec({ name: "plan_route_coverage", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "delivered_route_coverage", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "plan_graph_route_coverage", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "delivered_graph_route_coverage", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "flow_delivery_rate", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "change_pages_grounded", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "run_spec_final_agreement", dataType: "NUMERIC", polarity: "higher_better", range: UNIT }),
  spec({ name: "closed_loop_refusals", dataType: "NUMERIC", polarity: "lower_better", range: UNIT }),
  spec({ name: "sidekick_report_consistent", dataType: "BOOLEAN", polarity: "higher_better" }),
  spec({ name: "cost_per_useful_spec", dataType: "NUMERIC", polarity: "lower_better", range: { min: 0 }, state: "pending" }),
];

const BY_NAME = new Map(GRADER_CATALOG.map((s) => [s.name, s]));

/* The catalog entry a score name belongs to: the base name itself, or `<base>.<suffix>` of a family with that suffix. */
export function specOfScore(name: string): ScoreSpec | undefined {
  const direct = BY_NAME.get(name);
  if (direct) return direct;
  const dot = name.indexOf(".");
  if (dot < 1) return undefined;
  const base = BY_NAME.get(name.slice(0, dot));
  return base?.suffixes?.includes(name.slice(dot + 1)) ? base : undefined;
}

/* Whether a base name is in the catalog. */
export function isCatalogName(name: string): boolean {
  return BY_NAME.has(name);
}

/* Whether a grader emits this base name today; the pending entries are declared but have none. */
export function isGradedName(name: string): boolean {
  return BY_NAME.get(name)?.state === "graded";
}

/* A deterministic score of the catalog. Throws on a name the catalog does not declare, so a grader cannot invent one. */
export function scoreOf(raw: RawScore): Score {
  const s = specOfScore(raw.name);
  if (!s) throw new Error(`score ${raw.name} is not in the grader catalog`);
  return {
    name: raw.name,
    value: raw.value,
    dataType: s.dataType,
    polarity: s.polarity,
    source: "deterministic",
    graderVersion: s.graderVersion,
    ...(raw.comment !== undefined ? { comment: raw.comment.slice(0, MAX_SCORE_COMMENT_CHARS) } : {}),
    ...(raw.observationId !== undefined ? { observationId: raw.observationId } : {}),
  };
}
