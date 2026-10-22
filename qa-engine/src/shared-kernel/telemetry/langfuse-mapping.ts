/* The one module that decides how our spans read in Langfuse: the observation type each GenAI operation gets, the usage and cost buckets of a generation, and the input and output keys. Pure; no SDK. Langfuse's OTLP attribute mapping is documented for the keys below and is verified on a real instance by spike S0.5, not here. */

import { GENAI, type ConventionTokenUsage } from "./genai-semconv.ts";

export const LANGFUSE = {
  attrs: {
    observationType: "langfuse.observation.type",
    usageDetails: "langfuse.observation.usage_details",
    costDetails: "langfuse.observation.cost_details",
  },
} as const;

export type LangfuseObservationType = "agent" | "generation" | "tool" | "span";

/* `generation` is the only type Langfuse prices; `agent` and `tool` give the trace tree its shape; everything else is a plain span, which is what Langfuse reads a span with no type as, so the orchestrator's other spans (root, phases, context) carry no type key. */
export function langfuseObservationType(operation: string | undefined): LangfuseObservationType {
  if (operation === GENAI.operations.invokeAgent) return "agent";
  if (operation === GENAI.operations.chat) return "generation";
  if (operation === GENAI.operations.executeTool) return "tool";
  return "span";
}

const nonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/*
 * Langfuse's usage buckets are EXCLUSIVE: it prices each bucket at its own rate and adds them, so a token counted in two
 * buckets is paid for twice. The conventions' counts are inclusive (input holds the cache reads and writes, output holds the
 * reasoning tokens), so they are taken apart here. The buckets add up to the conventions' input plus output. A runtime that
 * reported a part larger than its whole is clamped, never made negative.
 */
export function langfuseUsageDetails(usage: ConventionTokenUsage): string {
  const cacheRead = nonNegative(usage.cacheRead);
  const cacheWrite = nonNegative(usage.cacheWrite);
  const reasoning = nonNegative(usage.reasoning);
  return JSON.stringify({
    input: Math.max(0, nonNegative(usage.input) - cacheRead - cacheWrite),
    output: Math.max(0, nonNegative(usage.output) - reasoning),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_reasoning_tokens: reasoning,
  });
}

/* The provider-reported cost of one generation. Absent when the provider reported none (zero or unknown): Langfuse then prices it from its model table or leaves it blank, rather than recording a false zero. */
export function langfuseCostDetails(cost: number): string | undefined {
  return Number.isFinite(cost) && cost > 0 ? JSON.stringify({ total: cost }) : undefined;
}
