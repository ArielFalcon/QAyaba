/*
 * One agent prompt as a trace: an `invoke_agent` span for the turn, a `qayaba.agent.attempt` span per attempt (the primary model,
 * then the fallback), and, once the turn is recorded, the `chat` and `execute_tool` children the tracker's records allow. The
 * transport policy tells it what happens (`AttemptEvent`), the facade decorator tells it when the prompt settles; every limit is
 * recorded by the layer that fires it and arrives here as a name.
 *
 * Attribute columns on `agent_turns` are the record and these spans mirror them (design §18 W4). A span is ended exactly once, by
 * whoever sees the thing it describes end: the attempt when the transport says so (or, when it never settles, when its turn is
 * closed or its session disposed, marked abandoned), the turn when the prompt settles for its caller.
 *
 * Observability never changes how a turn ends: every method is guarded and a fault is logged and dropped.
 */
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { attrKey } from "@kernel/telemetry/attribute-registry.ts";
import { GENAI, normalizeOpenCodeUsage } from "@kernel/telemetry/genai-semconv.ts";
import { LANGFUSE, langfuseObservationType } from "@kernel/telemetry/langfuse-mapping.ts";
import type { RedactionScope, SpanHandle, TelemetryClock, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import { StalledAgentError } from "@kernel/domain-error.ts";
import type { TurnLimit } from "@kernel/turn-limit.ts";
import type { AttemptAnswer, AttemptEvent, AgentTurnEvent } from "../agent-transport-policy.ts";
import { classifyAgentFault, type AgentErrorType } from "../../domain/agent-error-class.ts";
import type { StepIntentContext } from "../../domain/step-intent.ts";
import { parseModelRef } from "../agent-transport-policy.ts";
import type { ServerToolCall } from "../../domain/tool-link.ts";
import { emitTurnChildren, type ChildModel } from "./turn-children.ts";
import { recordContextSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import { SECTION_SOURCE, type SectionMeta } from "../../domain/section-meta.ts";
import type { ContextSource } from "../../domain/context-item-ids.ts";

export interface TurnIdentity {
  agent: string;
  role: string;
  sessionId: string;
  round: number | undefined;
  repair: boolean;
  delegationId: string | undefined;
  /* The model the prompt named, as `provider/model`; absent when it named none (the agent's configured model then applies, which is a config fact, not a request). */
  requestedModel: string | undefined;
  /* What the repository's copy of the agent configuration says, labelled as such. */
  config: { model: string | undefined; reasoningEffort: string | undefined; stepsLimit: number | undefined } | undefined;
  /* The step limit the prompt stated (the live read), never the repository copy. */
  stepLimit: number | undefined;
  prompt: {
    bytes: number;
    sectionSizes: Record<string, number> | null;
    sectionHashes: Record<string, string> | null;
    sectionItems: Record<string, SectionMeta> | null;
    sectionsDropped: number | undefined;
    budgetBytes: number | undefined;
  };
}

export interface TurnProbeDeps {
  telemetry: TelemetryPort;
  clock: TelemetryClock;
  intent: StepIntentContext;
  parent: TelemetryContext | undefined;
  secrets: RedactionScope | undefined;
  /* Subscribes the turn span to what the host does to the process (a suspend, a blocked loop); returns the way to stop. */
  watchHost: ((span: SpanHandle) => () => void) | undefined;
}

interface AttemptRecord {
  number: number;
  span: SpanHandle;
  requested: string | undefined;
  /* The transport said the attempt is over. */
  ended: boolean;
  /* The span has been ended: an attempt that answered, or was abandoned, keeps its span open until the turn is recorded so the children built from the turn's records end inside it. */
  spanEnded: boolean;
  endedAt: number | undefined;
}

/* The most served calls one turn remembers for its links: a turn's own trace keeps at most this many calls. */
const MAX_SERVED_CALLS = 500;

function guarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[qa] turn telemetry (${label}) failed and was dropped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* The delivered spans of the turn: one `qayaba.delivered.<source>` span per grounding source the kept assembly supplied, with the items it actually gave the agent and how many it left out. Read from the kept assembly's own metadata, never the prompt text. */
export function recordDeliveredContextSpans(
  telemetry: TelemetryPort,
  sections: Readonly<Record<string, SectionMeta>> | null | undefined,
  sectionSizes: Readonly<Record<string, number>> | null | undefined,
): void {
  if (!sections) return;
  guarded("delivered spans", () => {
    const bySource = new Map<ContextSource, { ids: string[]; bytes: number; omitted: number }>();
    for (const [sectionId, meta] of Object.entries(sections)) {
      const source = SECTION_SOURCE[sectionId];
      if (source === undefined) continue;
      const entry = bySource.get(source) ?? { ids: [], bytes: 0, omitted: 0 };
      entry.ids.push(...meta.itemIds);
      entry.bytes += sectionSizes?.[sectionId] ?? 0;
      entry.omitted += meta.omissions.reduce((sum, o) => sum + o.count, 0);
      bySource.set(source, entry);
    }
    for (const [source, entry] of bySource) {
      recordContextSpan(telemetry, {
        source,
        stage: "delivered",
        ids: entry.ids,
        bytes: entry.bytes,
        omitted: entry.omitted,
      });
    }
  });
}

const providerOf = (requested: string | undefined): string | undefined => (requested ? parseModelRef(requested)?.providerID : undefined);
const modelOf = (requested: string | undefined): string | undefined => (requested ? (parseModelRef(requested)?.modelID ?? requested) : undefined);

export class TurnProbe {
  private readonly span: SpanHandle;
  private readonly unwatchHost: (() => void) | undefined;
  private readonly attempts = new Map<number, AttemptRecord>();
  private last: AttemptRecord | undefined;
  private answered: AttemptAnswer | undefined;
  private turn: AgentTurnEvent | undefined;
  private settled = false;
  private outerLimit: TurnLimit | undefined;
  private fallbackUsed = false;
  private readonly startedAt: number;
  /* The calls the orchestrator served for this turn's session while it ran (run_spec, the authenticated browser). */
  private readonly served: ServerToolCall[] = [];

  constructor(
    private readonly deps: TurnProbeDeps,
    private readonly who: TurnIdentity,
  ) {
    const { telemetry, clock } = deps;
    this.startedAt = clock.now();
    const prompt = who.prompt;
    const requestedModel = modelOf(who.requestedModel);
    const provider = providerOf(who.requestedModel);
    this.span = telemetry.startSpan(`${GENAI.operations.invokeAgent} ${who.agent}`, {
      kind: "internal",
      startTime: this.startedAt,
      ...(deps.parent ? { parent: deps.parent } : {}),
      ...(deps.secrets ? { secrets: deps.secrets } : {}),
      attrs: {
        [GENAI.attrs.operationName]: GENAI.operations.invokeAgent,
        [GENAI.attrs.agentName]: who.agent,
        [GENAI.attrs.conversationId]: who.sessionId,
        ...(provider !== undefined ? { [GENAI.attrs.providerName]: provider } : {}),
        ...(requestedModel !== undefined ? { [GENAI.attrs.requestModel]: requestedModel } : {}),
        ...(who.config
          ? {
              "qayaba.config.source": "repo-copy",
              ...(who.config.model !== undefined ? { "qayaba.config.model": who.config.model } : {}),
              ...(who.config.reasoningEffort !== undefined ? { "qayaba.config.reasoning_effort": who.config.reasoningEffort } : {}),
              ...(who.config.stepsLimit !== undefined ? { "qayaba.config.steps_limit": who.config.stepsLimit } : {}),
            }
          : {}),
        "qayaba.agent.role": who.role,
        ...(who.round !== undefined ? { "qayaba.agent.round": who.round } : {}),
        "qayaba.agent.repair": who.repair,
        ...(who.delegationId !== undefined ? { "qayaba.delegation.id": who.delegationId } : {}),
        ...(who.stepLimit !== undefined ? { "qayaba.agent.steps.limit": who.stepLimit } : {}),
        "qayaba.prompt.bytes": prompt.bytes,
        ...(prompt.sectionsDropped !== undefined ? { "qayaba.prompt.sections.dropped": prompt.sectionsDropped } : {}),
        ...(prompt.budgetBytes !== undefined ? { "qayaba.prompt.budget_bytes": prompt.budgetBytes } : {}),
        ...sectionAttrs(prompt.sectionSizes, prompt.sectionHashes),
        [LANGFUSE.attrs.observationType]: langfuseObservationType(GENAI.operations.invokeAgent),
      },
    });
    this.unwatchHost = deps.watchHost ? safeWatch(deps.watchHost, this.span) : undefined;
    /* The grounding this turn actually handed the agent, as delivered spans beside the produced ones. */
    recordDeliveredContextSpans(telemetry, prompt.sectionItems, prompt.sectionSizes);
  }

  /* True once the prompt has settled for its caller and no attempt is left open: nothing more will be told. */
  isDone(): boolean {
    return this.settled && [...this.attempts.values()].every((a) => a.spanEnded);
  }

  /* The attempt span a tool call served right now belongs under: the latest attempt, while its span is open. */
  liveAttempt(): SpanHandle | undefined {
    return this.last && !this.last.spanEnded ? this.last.span : undefined;
  }

  /* The orchestrator served a tool call for this turn's session; its span is linked from the call's synthesized span once the turn is recorded. */
  noteToolCall(call: ServerToolCall): void {
    if (this.served.length < MAX_SERVED_CALLS) this.served.push(call);
  }

  /* A limit a layer above the transport fired on this turn (the stall watchdog). */
  limit(fired: TurnLimit): void {
    this.outerLimit = fired;
  }

  firedByOuter(): TurnLimit | undefined {
    return this.outerLimit;
  }

  onAttempt(event: AttemptEvent): void {
    guarded(`attempt ${event.kind}`, () => {
      if (event.kind === "start") this.attemptStarted(event);
      else if (event.kind === "end") this.attemptEnded(event);
      else if (event.kind === "fallback") this.fellBack(event);
      else this.turnRecorded(event.turn);
    });
  }

  private attemptStarted(event: Extract<AttemptEvent, { kind: "start" }>): void {
    this.flushEnds();
    const requested = event.requestedModel;
    const model = modelOf(requested);
    const provider = providerOf(requested);
    const span = this.deps.telemetry.startSpan("qayaba.agent.attempt", {
      kind: "internal",
      parent: this.span,
      startTime: event.at,
      attrs: {
        "qayaba.attempt": event.attempt,
        ...(model !== undefined ? { [GENAI.attrs.requestModel]: model } : {}),
        ...(provider !== undefined ? { [GENAI.attrs.providerName]: provider } : {}),
      },
    });
    const record: AttemptRecord = { number: event.attempt, span, requested, ended: false, spanEnded: false, endedAt: undefined };
    this.attempts.set(event.attempt, record);
    this.last = record;
    this.span.setAttrs({ "qayaba.limit.applied": event.limitApplied.source, "qayaba.limit.applied_ms": Math.round(event.limitApplied.ms) });
  }

  private attemptEnded(event: Omit<Extract<AttemptEvent, { kind: "end" }>, "prompt">): void {
    const record = this.attempts.get(event.attempt);
    if (!record || record.ended) return;
    record.ended = true;
    if (event.answered) this.answered = event.answered;
    const answered = event.answered;
    const usage = event.usage ? normalizeOpenCodeUsage(event.usage) : undefined;
    const provider = answered?.providerId ?? providerOf(record.requested);
    const attrs: Attrs = {
      ...(answered?.modelId !== undefined ? { [GENAI.attrs.responseModel]: answered.modelId } : {}),
      ...(answered?.providerId !== undefined ? { [GENAI.attrs.providerName]: answered.providerId } : {}),
      ...(answered?.finish !== undefined ? { [GENAI.attrs.responseFinishReasons]: [answered.finish] } : {}),
      ...(usage
        ? {
            "qayaba.usage.input_tokens": usage.input,
            "qayaba.usage.output_tokens": usage.output,
            "qayaba.usage.cache_read_tokens": usage.cacheRead,
            "qayaba.usage.cache_write_tokens": usage.cacheWrite,
            "qayaba.usage.reasoning_tokens": usage.reasoning,
            ...(event.usage!.cost !== undefined ? { "qayaba.usage.cost": event.usage!.cost } : {}),
            "qayaba.usage.source": "final-message",
          }
        : {}),
      ...(event.errorType ? { "error.type": event.errorType } : {}),
      ...(event.abandoned || this.settled ? { "qayaba.agent.abandoned": true } : {}),
    };
    record.span.setAttrs(attrs);
    if (event.error !== undefined) record.span.recordError(event.error, event.errorType ? { "error.type": event.errorType } : undefined);
    if (event.errorType) {
      const model = answered?.modelId ?? modelOf(record.requested);
      this.deps.telemetry.counter("qayaba.provider.errors")(1, {
        ...(provider !== undefined ? { [GENAI.attrs.providerName]: provider } : {}),
        ...(model !== undefined ? { [GENAI.attrs.requestModel]: model } : {}),
        "error.type": event.errorType,
      } as Attrs);
    }
    record.endedAt = event.at;
    /* A failed attempt has no turn to build children for; one that answered, or was abandoned, ends when its turn is recorded. */
    if (event.error !== undefined || (event.errorType !== undefined && !event.abandoned)) this.endSpan(record);
  }

  private endSpan(record: AttemptRecord): void {
    if (record.spanEnded) return;
    record.spanEnded = true;
    record.span.end(record.endedAt);
  }

  /* Ends the spans of the attempts the transport has finished with. */
  private flushEnds(): void {
    for (const record of this.attempts.values()) if (record.ended) this.endSpan(record);
  }

  private fellBack(event: Extract<AttemptEvent, { kind: "fallback" }>): void {
    this.fallbackUsed = true;
    const model = modelOf(event.model);
    this.span.addEvent("fallback_model_used", model !== undefined ? { [GENAI.attrs.requestModel]: model } : undefined, event.at);
    this.span.setAttrs({ "qayaba.agent.fallback_used": true });
  }

  private childModel(): ChildModel {
    const requested = this.last?.requested;
    return { request: modelOf(requested), response: this.answered?.modelId, provider: this.answered?.providerId ?? providerOf(requested) };
  }

  private turnRecorded(turn: AgentTurnEvent): void {
    this.turn = turn;
    const metrics = turn.callMetrics;
    const trace = metrics?.trace;
    const endedAt = this.last?.endedAt ?? this.deps.clock.now();
    /* A turn recorded after its span ended (a stall rejected the outer promise first) puts its figures on the attempt, which is still open. */
    const target = this.settled ? (this.last?.span ?? this.span) : this.span;
    let childSteps = 0;
    if (trace && this.last) {
      childSteps = emitTurnChildren({
        telemetry: this.deps.telemetry,
        parent: this.last.span,
        secrets: this.deps.secrets,
        trace,
        agent: this.who.agent,
        role: this.who.role,
        model: this.childModel(),
        stepLimit: this.who.stepLimit,
        intent: this.deps.intent,
        servers: this.served,
        endedAt,
      }).steps;
    }
    const usage = metrics?.usage ? normalizeOpenCodeUsage(metrics.usage) : undefined;
    const finalMessage = turn.tokensInput !== null && turn.tokensInput !== undefined
      ? normalizeOpenCodeUsage({ input: turn.tokensInput, output: turn.tokensOutput ?? 0, reasoning: turn.tokensReasoning ?? 0, cacheRead: turn.tokensCacheRead ?? 0, cacheWrite: turn.tokensCacheWrite ?? 0 })
      : undefined;
    const sums = usage ?? finalMessage;
    const cost = metrics?.usage?.cost ?? turn.cost ?? undefined;
    const calls = metrics?.buckets ?? {};
    const reasoningBeforeFirstCall = trace ? reasoningTokensBeforeFirstCall(trace) : undefined;
    target.setAttrs({
      ...(turn.promptHash ? { "qayaba.prompt.hash": turn.promptHash } : {}),
      ...(sums
        ? {
            "qayaba.usage.input_tokens": sums.input,
            "qayaba.usage.output_tokens": sums.output,
            "qayaba.usage.cache_read_tokens": sums.cacheRead,
            "qayaba.usage.cache_write_tokens": sums.cacheWrite,
            "qayaba.usage.reasoning_tokens": sums.reasoning,
          }
        : {}),
      ...(cost !== undefined ? { "qayaba.usage.cost": cost } : {}),
      "qayaba.usage.source": usage ? "steps" : finalMessage ? "final-message" : "none",
      ...(metrics
        ? {
            "qayaba.agent.observation_complete": metrics.observationComplete,
            ...(metrics.stepsUsed !== null ? { "qayaba.agent.steps.used": metrics.stepsUsed } : {}),
            "qayaba.agent.calls.total": metrics.totalCalls,
            ...Object.fromEntries(Object.entries(calls).map(([bucket, n]) => [attrKey.agentCalls(bucket), n])),
            "qayaba.agent.calls.denied": metrics.deniedCallCount,
            "qayaba.agent.reads.redundant": metrics.redundantReadCount,
            "qayaba.agent.reads.prompt_provided": metrics.promptProvidedReadCount + metrics.pathProvidedReadCount,
            "qayaba.agent.writes": metrics.writeCount,
            ...(metrics.timeToFirstCallMs !== null ? { "qayaba.agent.ms_to_first_call": metrics.timeToFirstCallMs } : {}),
            ...(metrics.timeToFirstWriteMs !== null ? { "qayaba.agent.ms_to_first_write": metrics.timeToFirstWriteMs } : {}),
          }
        : {}),
      ...(trace?.firstStepAt != null && trace.startedAt != null ? { "qayaba.agent.ms_to_first_step": Math.max(0, trace.firstStepAt - trace.startedAt) } : {}),
      ...(reasoningBeforeFirstCall !== undefined ? { "qayaba.agent.reasoning_tokens_before_first_call": reasoningBeforeFirstCall } : {}),
      ...(trace?.truncated ? { "qayaba.agent.trace_truncated": true } : {}),
      ...(this.answered?.modelId !== undefined ? { [GENAI.attrs.responseModel]: this.answered.modelId } : {}),
      ...(this.answered?.providerId !== undefined ? { [GENAI.attrs.providerName]: this.answered.providerId } : {}),
      "qayaba.agent.fallback_used": this.fallbackUsed || turn.fallbackUsed === true,
      "qayaba.agent.end": turn.ended ?? "completed",
    });
    if (turn.ended === "exhausted") target.addEvent("step_budget_exhausted", this.who.stepLimit !== undefined ? { "qayaba.agent.steps.limit": this.who.stepLimit } : undefined);
    this.recordMetrics(turn, metrics?.stepsUsed ?? (trace ? childSteps : null), cost, metrics?.totalCalls ?? 0, childSteps);
    this.flushEnds();
  }

  private recordMetrics(turn: AgentTurnEvent, steps: number | null, cost: number | undefined, tools: number, inferences: number): void {
    const { telemetry } = this.deps;
    const agentName = { [GENAI.attrs.agentName]: this.who.agent } as Attrs;
    telemetry.histogram(GENAI.metrics.invokeAgentDuration)(Math.max(0, (turn.durationMs ?? this.deps.clock.now() - this.startedAt)) / 1000, agentName);
    telemetry.histogram(GENAI.metrics.invokeAgentToolCalls)(tools, agentName);
    telemetry.histogram(GENAI.metrics.invokeAgentInferenceCalls)(inferences, agentName);
    if (steps !== null) telemetry.histogram("qayaba.agent.steps")(steps, { "qayaba.agent.role": this.who.role });
    if (cost !== undefined && cost > 0) {
      const model = this.answered?.modelId ?? modelOf(this.last?.requested);
      telemetry.counter("qayaba.agent.cost")(cost, { "qayaba.agent.role": this.who.role, ...(model !== undefined ? { [GENAI.attrs.requestModel]: model } : {}) } as Attrs);
    }
  }

  /* The prompt settled for its caller: the turn span ends here, with whatever limit and end the turn is known to have had. */
  settle(outcome: { ok: true } | { ok: false; error: unknown }): void {
    guarded("settle", () => {
      if (this.settled) return;
      this.settled = true;
      const fired = this.outerLimit ?? this.turn?.limitFired ?? (outcome.ok ? undefined : limitOfFault(outcome.error));
      const failure: AgentErrorType | undefined = outcome.ok ? undefined : classifyAgentFault(outcome.error);
      this.span.setAttrs({
        "qayaba.limit.fired": fired ?? "none",
        ...(this.turn === undefined ? { "qayaba.agent.end": fired === "stall" ? "aborted" : endOfFault(failure), "qayaba.usage.source": "none" } : {}),
        ...(failure ? { "error.type": failure } : {}),
      });
      if (!outcome.ok) this.span.recordError(outcome.error, failure ? { "error.type": failure } : undefined);
      this.unwatchHost?.();
      this.span.end(this.deps.clock.now());
    });
  }

  /* The session is disposed: an attempt the transport never closed ends here, abandoned, so no span outlives its session. */
  closeAll(): void {
    guarded("close", () => {
      const at = this.deps.clock.now();
      for (const record of this.attempts.values()) {
        if (!record.ended) this.attemptEnded({ kind: "end", attempt: record.number, at, abandoned: true });
      }
      this.flushEnds();
      this.settle({ ok: true });
    });
  }
}

function safeWatch(watch: (span: SpanHandle) => () => void, span: SpanHandle): (() => void) | undefined {
  try {
    return watch(span);
  } catch (err) {
    console.error(`[qa] turn telemetry (host watch) failed and was dropped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function sectionAttrs(sizes: Record<string, number> | null, hashes: Record<string, string> | null): Attrs {
  const attrs: Record<string, number | string> = {};
  for (const [id, bytes] of Object.entries(sizes ?? {})) attrs[attrKey.promptSectionBytes(id)] = bytes;
  for (const [id, hash] of Object.entries(hashes ?? {})) attrs[attrKey.promptSectionHash(id)] = hash;
  return attrs as Attrs;
}

/* Reasoning tokens spent in the steps up to and including the one that made the turn's first call: the model reasons before it acts. */
function reasoningTokensBeforeFirstCall(trace: NonNullable<NonNullable<AgentTurnEvent["callMetrics"]>["trace"]>): number | undefined {
  const first = trace.calls.find((call) => call.step !== null);
  if (!first || first.step === null) return undefined;
  return trace.steps.filter((step) => step.index <= first.step!).reduce((sum, step) => sum + (step.usage?.reasoning ?? 0), 0);
}

function limitOfFault(error: unknown): TurnLimit | undefined {
  if (error instanceof StalledAgentError) return "stall";
  return undefined;
}

function endOfFault(failure: AgentErrorType | undefined): "timeout" | "aborted" | "failed" {
  if (failure === "timeout") return "timeout";
  if (failure === "aborted") return "aborted";
  return "failed";
}

