/* Every metric instrument, declared with the attribute keys it may carry. Metric attributes come only from this closed set of low-cardinality registry keys: ids, shas, urls, paths, selectors and hosts go on spans, never on a metric (design §8.2). The adapter records only declared instruments with declared keys; `checkInstrumentTable` is the guard the tests run over this table. */

import { lookupAttribute, type RegisteredKey } from "./attribute-registry.ts";
import { GENAI } from "./genai-semconv.ts";

export type InstrumentType = "counter" | "histogram" | "gauge";

export interface InstrumentSpec {
  readonly type: InstrumentType;
  readonly attrs: readonly RegisteredKey[];
}
export type InstrumentTable = Readonly<Record<string, InstrumentSpec>>;

const MODEL = [GENAI.attrs.providerName, GENAI.attrs.requestModel] as const;

export const INSTRUMENTS = {
  "qayaba.runs": { type: "counter", attrs: ["qayaba.app", "qayaba.verdict", "qayaba.error_class", "qayaba.runtime", "qayaba.mode", "qayaba.furthest_phase"] },
  "qayaba.run.duration": { type: "histogram", attrs: ["qayaba.app", "qayaba.verdict", "qayaba.mode"] },
  "qayaba.phase.duration": { type: "histogram", attrs: ["qayaba.phase", "qayaba.app"] },
  "qayaba.budget.exhausted": { type: "counter", attrs: ["qayaba.limit.fired", "qayaba.agent.role"] },
  "qayaba.infra_errors": { type: "counter", attrs: ["qayaba.error_class", "qayaba.app"] },
  /* One verdict per review round: what decided it and how it read, beside the turn's own invoke_agent
   * span and agent_turns row (duration, tokens, cost, steps). */
  "qayaba.review": { type: "counter", attrs: ["qayaba.app", "qayaba.review.outcome", "qayaba.review.decided_by", "qayaba.review.correction_class"] },
  "qayaba.review.duration": { type: "histogram", attrs: ["qayaba.app", "qayaba.review.outcome"] },
  "qayaba.agent.steps": { type: "histogram", attrs: ["qayaba.agent.role"] },
  "qayaba.agent.cost": { type: "counter", attrs: ["qayaba.agent.role", GENAI.attrs.requestModel, "qayaba.app"] },
  "qayaba.provider.errors": { type: "counter", attrs: [...MODEL, "error.type"] },
  "qayaba.egress.denied": { type: "counter", attrs: ["qayaba.exec.profile"] },
  "qayaba.code_graph.index": { type: "counter", attrs: ["qayaba.code_graph.outcome"] },
  /* What a run's grounding, login and tests came to. */
  "qayaba.tests": { type: "counter", attrs: ["qayaba.test.status", "qayaba.test.failure_category"] },
  "qayaba.auth.attempts": { type: "counter", attrs: ["qayaba.auth.outcome"] },
  "qayaba.context.bytes": { type: "histogram", attrs: ["qayaba.context.source", "qayaba.context.stage"] },
  "qayaba.context.items": { type: "histogram", attrs: ["qayaba.context.source", "qayaba.context.stage"] },
  "qayaba.context.cut": { type: "counter", attrs: ["qayaba.context.source", "qayaba.context.cut_class", "qayaba.context.cut_reason"] },
  "qayaba.context.cut_items": { type: "histogram", attrs: ["qayaba.context.source", "qayaba.context.cut_class", "qayaba.context.cut_reason"] },
  "qayaba.context.freshness.age": { type: "histogram", attrs: ["qayaba.context.source"] },
  "qayaba.context.stale": { type: "counter", attrs: ["qayaba.context.source", "qayaba.context.stale_reason"] },
  "qayaba.context.recapture": { type: "counter", attrs: ["qayaba.context.source", "qayaba.context.recapture.outcome"] },
  /* Evaluation scores: a gauge so a regrade replaces the series, and a counter for closed-set classes only (a regrade counts again). */
  "qayaba.eval.score": { type: "gauge", attrs: ["qayaba.eval.name", "qayaba.eval.source", "qayaba.eval.data_type", "qayaba.app", "qayaba.verdict"] },
  "qayaba.eval.class": { type: "counter", attrs: ["qayaba.eval.name", "qayaba.eval.value"] },
  /* Host health (design §7): process-wide; the only attribute is the closed stat (p50, p99, max). */
  "qayaba.host.suspend.count": { type: "counter", attrs: [] },
  "qayaba.host.suspend.duration": { type: "histogram", attrs: [] },
  "qayaba.host.event_loop.delay": { type: "histogram", attrs: ["qayaba.event_loop.stat"] },
  "qayaba.host.event_loop.blocked": { type: "counter", attrs: [] },
  "qayaba.sandbox.zombies": { type: "gauge", attrs: [] },
  [GENAI.metrics.inferenceDuration]: { type: "histogram", attrs: [...MODEL, "error.type"] },
  [GENAI.metrics.inputTokens]: { type: "counter", attrs: [...MODEL, "qayaba.agent.role"] },
  [GENAI.metrics.outputTokens]: { type: "counter", attrs: [...MODEL, "qayaba.agent.role"] },
  [GENAI.metrics.cacheReadInputTokens]: { type: "counter", attrs: [...MODEL, "qayaba.agent.role"] },
  [GENAI.metrics.cacheWriteInputTokens]: { type: "counter", attrs: [...MODEL, "qayaba.agent.role"] },
  [GENAI.metrics.reasoningOutputTokens]: { type: "counter", attrs: [...MODEL, "qayaba.agent.role"] },
  [GENAI.metrics.invokeAgentDuration]: { type: "histogram", attrs: [GENAI.attrs.agentName] },
  [GENAI.metrics.invokeAgentToolCalls]: { type: "histogram", attrs: [GENAI.attrs.agentName] },
  [GENAI.metrics.invokeAgentInferenceCalls]: { type: "histogram", attrs: [GENAI.attrs.agentName] },
} as const satisfies InstrumentTable;

/* A name segment that marks a value as unbounded however the registry classed it. */
const DENYLISTED_SEGMENTS = new Set(["id", "sha", "url", "path", "selector", "host"]);

/* The problems of a table, one line each; empty when it is sound. */
export function checkInstrumentTable(table: InstrumentTable): string[] {
  const problems: string[] = [];
  for (const [name, instrument] of Object.entries(table)) {
    for (const key of instrument.attrs) {
      const segments = key.split(".");
      if (segments.some((s) => DENYLISTED_SEGMENTS.has(s))) problems.push(`${name}: ${key} is on the cardinality denylist`);
      const registered = lookupAttribute(key);
      if (registered === undefined) problems.push(`${name}: ${key} is not in the attribute registry`);
      else if (registered.cardinality !== "low") problems.push(`${name}: ${key} is high-cardinality in the registry`);
    }
  }
  return problems;
}
