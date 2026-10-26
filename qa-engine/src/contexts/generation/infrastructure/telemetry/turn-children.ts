/*
 * The children of an attempt that the event stream lets the orchestrator reconstruct once the turn is over: one `chat` span per
 * step and one `execute_tool` span per call. They are built from the tracker's records, never observed live, and say so
 * (`qayaba.span.synthesized`). A call's times are the runtime's own (`qayaba.time.source=state`); a step's are the moments the
 * orchestrator received its start and finish, because the runtime stamps neither (`receive`). Observability never changes how a
 * turn ends: the caller guards this whole function.
 */
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { GENAI, normalizeOpenCodeUsage } from "@kernel/telemetry/genai-semconv.ts";
import { LANGFUSE, langfuseCostDetails, langfuseObservationType, langfuseUsageDetails } from "@contexts/generation/domain/langfuse-mapping.ts";
import type { RedactionScope, SpanHandle, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import { classifyNavOutcome, isNavigationCall, type NavOutcomeInput } from "../../domain/nav-outcome.ts";
import { classifyStepIntents, type StepCall, type StepIntentContext } from "../../domain/step-intent.ts";
import type { CallTrace, StepTrace, TurnTrace } from "../../domain/turn-trace.ts";
import { matchServerCalls, type ServerToolCall } from "../../domain/tool-link.ts";

/* The metrics a step feeds; the model and provider are the closed sets the instrument table allows. */
export interface ChildModel {
  request: string | undefined;
  response: string | undefined;
  provider: string | undefined;
}

export interface ChildrenInput {
  telemetry: TelemetryPort;
  parent: SpanHandle;
  secrets: RedactionScope | undefined;
  trace: TurnTrace;
  agent: string;
  role: string;
  model: ChildModel;
  stepLimit: number | undefined;
  intent: StepIntentContext;
  /* The calls the orchestrator served for this turn's session (run_spec, the authenticated browser): a tool span that matches one carries a link to its server span. */
  servers?: readonly ServerToolCall[];
  /* Where an unfinished step or call ends: the moment the attempt did. No child ends after it, so a child never outlives its parent. */
  endedAt: number;
}

export interface ChildrenSummary {
  steps: number;
  calls: number;
}

const modelName = (model: ChildModel): string | undefined => model.response ?? model.request;

function stepCallOf(call: CallTrace): StepCall {
  return { tool: call.tool, bucket: call.bucket, targetKind: call.targetKind, target: call.target, ...(call.relPath !== undefined ? { relPath: call.relPath } : {}) };
}

function navigation(call: CallTrace, intent: StepIntentContext): NavOutcomeInput {
  return {
    status: call.status === "error" ? "error" : "completed",
    output: call.navOutput ?? "",
    ...(call.targetKind === "url" && call.target !== null ? { requestedUrl: call.target } : {}),
    loginUrls: intent.loginUrls,
    authOnlyOrigins: intent.authOnlyOrigins,
  };
}

function stepAttrs(step: StepTrace, intent: string, input: ChildrenInput): Attrs {
  const model = modelName(input.model);
  const usage = step.usage ? normalizeOpenCodeUsage(step.usage) : undefined;
  const cost = step.usage ? langfuseCostDetails(step.usage.cost) : undefined;
  return {
    [GENAI.attrs.operationName]: GENAI.operations.chat,
    ...(model !== undefined ? { [GENAI.attrs.requestModel]: input.model.request ?? model } : {}),
    ...(input.model.response !== undefined ? { [GENAI.attrs.responseModel]: input.model.response } : {}),
    ...(input.model.provider !== undefined ? { [GENAI.attrs.providerName]: input.model.provider } : {}),
    ...(step.reason !== null ? { [GENAI.attrs.responseFinishReasons]: [step.reason] } : {}),
    ...(usage
      ? {
          [GENAI.attrs.usageInputTokens]: usage.input,
          [GENAI.attrs.usageOutputTokens]: usage.output,
          [GENAI.attrs.usageCacheReadInputTokens]: usage.cacheRead,
          [GENAI.attrs.usageCacheWriteInputTokens]: usage.cacheWrite,
          [GENAI.attrs.usageReasoningOutputTokens]: usage.reasoning,
          "qayaba.usage.cost": step.usage!.cost,
          /* A generation is the one observation Langfuse prices: its exclusive buckets, and the provider's cost when it reported one. */
          [LANGFUSE.attrs.usageDetails]: langfuseUsageDetails(usage),
          ...(cost !== undefined ? { [LANGFUSE.attrs.costDetails]: cost } : {}),
        }
      : {}),
    "qayaba.agent.step": step.index,
    ...(input.stepLimit !== undefined ? { "qayaba.agent.step_budget.remaining": Math.max(0, input.stepLimit - step.index) } : {}),
    "qayaba.step.intent": intent,
    "qayaba.span.synthesized": true,
    "qayaba.time.source": "receive",
    [LANGFUSE.attrs.observationType]: langfuseObservationType(GENAI.operations.chat),
  };
}

function recordStepMetrics(step: StepTrace, startedAt: number, endedAt: number, input: ChildrenInput): void {
  const model = input.model.response ?? input.model.request;
  const modelAttrs = {
    ...(input.model.provider !== undefined ? { [GENAI.attrs.providerName]: input.model.provider } : {}),
    ...(model !== undefined ? { [GENAI.attrs.requestModel]: model } : {}),
  } as Attrs;
  input.telemetry.histogram(GENAI.metrics.inferenceDuration)(Math.max(0, endedAt - startedAt) / 1000, modelAttrs);
  if (!step.usage) return;
  const usage = normalizeOpenCodeUsage(step.usage);
  const withRole = { ...modelAttrs, "qayaba.agent.role": input.role } as Attrs;
  input.telemetry.counter(GENAI.metrics.inputTokens)(usage.input, withRole);
  input.telemetry.counter(GENAI.metrics.outputTokens)(usage.output, withRole);
  input.telemetry.counter(GENAI.metrics.cacheReadInputTokens)(usage.cacheRead, withRole);
  input.telemetry.counter(GENAI.metrics.cacheWriteInputTokens)(usage.cacheWrite, withRole);
  input.telemetry.counter(GENAI.metrics.reasoningOutputTokens)(usage.reasoning, withRole);
}

function toolAttrs(call: CallTrace, input: ChildrenInput): Attrs {
  const real = call.startedAt !== null;
  return {
    [GENAI.attrs.operationName]: GENAI.operations.executeTool,
    [GENAI.attrs.toolName]: call.tool,
    [GENAI.attrs.toolCallId]: call.callId,
    "qayaba.tool.bucket": call.bucket,
    "qayaba.tool.status": call.denied ? "denied" : call.status,
    ...(call.target !== null ? { "qayaba.tool.target": call.target } : {}),
    ...(call.step !== null ? { "qayaba.agent.step": call.step } : {}),
    ...(isNavigationCall(call.tool) && call.status !== "running" ? { "qayaba.nav.outcome": classifyNavOutcome(navigation(call, input.intent)) } : {}),
    "qayaba.span.synthesized": true,
    "qayaba.time.source": real ? "state" : "receive",
    [LANGFUSE.attrs.observationType]: langfuseObservationType(GENAI.operations.executeTool),
  };
}

export function emitTurnChildren(input: ChildrenInput): ChildrenSummary {
  const { telemetry, parent, secrets, trace } = input;
  const callsByStep = new Map<number, CallTrace[]>();
  for (const call of trace.calls) {
    if (call.step === null) continue;
    const list = callsByStep.get(call.step) ?? [];
    list.push(call);
    callsByStep.set(call.step, list);
  }
  const intents = classifyStepIntents(
    trace.steps.map((step) => ({ calls: (callsByStep.get(step.index) ?? []).map(stepCallOf) })),
    input.intent,
    input.agent,
  );
  const name = modelName(input.model);
  let previousEnd = trace.startedAt ?? trace.steps[0]?.startedAt ?? input.endedAt;
  trace.steps.forEach((step, i) => {
    const startedAt = Math.min(step.startedAt ?? previousEnd, input.endedAt);
    const endedAt = Math.min(Math.max(startedAt, step.finishedAt ?? input.endedAt), input.endedAt);
    previousEnd = endedAt;
    const span = telemetry.startSpan(name !== undefined ? `${GENAI.operations.chat} ${name}` : GENAI.operations.chat, {
      kind: "client",
      parent,
      startTime: startedAt,
      ...(secrets ? { secrets } : {}),
      attrs: stepAttrs(step, intents[i]!, input),
    });
    span.end(endedAt);
    recordStepMetrics(step, startedAt, endedAt, input);
  });
  const served = input.servers && input.servers.length > 0 ? matchServerCalls(trace.calls, input.servers) : undefined;
  for (const call of trace.calls) {
    const startedAt = Math.min(call.startedAt ?? call.firstSeenAt, input.endedAt);
    const endedAt = Math.min(Math.max(startedAt, call.endedAt ?? input.endedAt), input.endedAt);
    const server = served?.get(call.callId);
    const span = telemetry.startSpan(`${GENAI.operations.executeTool} ${call.tool}`, {
      kind: "internal",
      parent,
      startTime: startedAt,
      ...(server ? { links: [{ context: server.context }] } : {}),
      ...(secrets ? { secrets } : {}),
      attrs: toolAttrs(call, input),
    });
    span.end(endedAt);
  }
  return { steps: trace.steps.length, calls: trace.calls.length };
}
