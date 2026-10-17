/* The one module that spells a `gen_ai.*` key or metric name. The OpenTelemetry GenAI conventions are in "Development", have no release and moved to their own repository, so every name the engine emits goes through this mapping and a rename is a change to this file alone. Current names only: legacy names are never emitted alongside them. */

/* The revision of open-telemetry/semantic-conventions-genai this mapping follows; recorded on the run as `qayaba.semconv.genai_rev`. */
export const GENAI_SEMCONV_REV = "main@2026-10-14";

export const GENAI = {
  /* Span attribute keys. `usage.input_tokens` includes cached tokens; the cache and reasoning counts are subsets of it. */
  attrs: {
    operationName: "gen_ai.operation.name",
    agentName: "gen_ai.agent.name",
    conversationId: "gen_ai.conversation.id",
    providerName: "gen_ai.provider.name",
    requestModel: "gen_ai.request.model",
    responseModel: "gen_ai.response.model",
    requestReasoningLevel: "gen_ai.request.reasoning.level",
    responseFinishReasons: "gen_ai.response.finish_reasons",
    toolName: "gen_ai.tool.name",
    usageInputTokens: "gen_ai.usage.input_tokens",
    usageOutputTokens: "gen_ai.usage.output_tokens",
    usageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
    usageCacheWriteInputTokens: "gen_ai.usage.cache_write.input_tokens",
    usageReasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens",
    inputMessages: "gen_ai.input.messages",
    outputMessages: "gen_ai.output.messages",
  },
  /* Values of `gen_ai.operation.name`, which are also the span name prefixes. */
  operations: {
    invokeAgent: "invoke_agent",
    chat: "chat",
    executeTool: "execute_tool",
  },
  /* Metric instrument names. */
  metrics: {
    inferenceDuration: "gen_ai.client.inference.duration",
    inputTokens: "gen_ai.client.inference.usage.input_tokens",
    outputTokens: "gen_ai.client.inference.usage.output_tokens",
    cacheReadInputTokens: "gen_ai.client.inference.usage.cache_read.input_tokens",
    cacheWriteInputTokens: "gen_ai.client.inference.usage.cache_write.input_tokens",
    reasoningOutputTokens: "gen_ai.client.inference.usage.reasoning.output_tokens",
    invokeAgentDuration: "gen_ai.invoke_agent.duration",
    invokeAgentToolCalls: "gen_ai.invoke_agent.tool_calls",
    invokeAgentInferenceCalls: "gen_ai.invoke_agent.inference_calls",
  },
} as const;

export type GenAiAttrKey = (typeof GENAI.attrs)[keyof typeof GENAI.attrs];
export type GenAiMetricName = (typeof GENAI.metrics)[keyof typeof GENAI.metrics];
