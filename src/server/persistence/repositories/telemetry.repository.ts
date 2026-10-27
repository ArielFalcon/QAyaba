import type { TurnEnd } from "@kernel/turn-end";
import type { ToolSequenceEntry, TurnCallMetrics, TurnUsage } from "@contexts/generation/application/index";
import type { TimeLimitSource, TurnLimit } from "@kernel/turn-limit";
import type { HistoryDatabase } from "../database";
import { parseJsonColumn } from "../json-column";
import { computeTelemetryAnalysis, type TelemetryAnalysis } from "../telemetry-analysis.query";

export interface AgentTurnRecord {
  runId: string | null;        /* maps to RunRecord.id; null for turns with no parent run */
  sessionId: string;           /* OpenCode session id */
  role: string;                /* agent name (qa-author, qa-reviewer, …) */
  round: number;               /* 0-based generation round within the session */
  isRepair: boolean;           /* true for in-session contract-repair re-prompts */
  ts: string;                  /* ISO-8601 timestamp when the turn completed */
  objective: string | null;    /* human-readable objective scope (null when not supplied) */
  promptText: string;          /* full prompt sent to the agent */
  outputText: string;          /* agent reply, sanitized before persist */
  promptBytes: number;         /* byte length of promptText */
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  cost: number | null;
  /*
   * Per-turn efficiency measurements. Each is null when the runtime or the row
   * cannot supply it — never a fabricated zero/false. Omitted on write means null.
   */
  totalCalls?: number | null;
  stepsUsed?: number | null;
  maxSteps?: number | null;
  callsBeforeFirstWrite?: number | null;
  writeCount?: number | null;
  redundantReadCount?: number | null;
  /* Re-reads of a file already read in the session, whatever window, with no write to it in between. */
  sameFileReadCount?: number | null;
  duplicateCallCount?: number | null;
  promptProvidedReadCount?: number | null;
  /* Content reads of a file the prompt listed by path as rendered; apart from the content-based promptProvidedReadCount. */
  pathProvidedReadCount?: number | null;
  /* Content reads whose lines a code-graph answer earlier in the session had already shown; apart from the prompt's two counts. */
  graphProvidedReadCount?: number | null;
  exhausted?: boolean | null;
  callBuckets?: Record<string, number> | null;
  /* How the turn ended; null when the row predates the column or the runtime does not say. A turn that ended by timeout or abort has empty output_text and only the calls measured up to its end. */
  ended?: TurnEnd | null;
  /* What a turn that ended by timeout or abort had streamed (its text and reasoning, bounded and redacted by the transport); null for an answered turn, one that streamed nothing, or a row that predates the column. */
  partialText?: string | null;
  /* Wall time of the turn, from the prompt being sent to its end; null when the row predates the column or the runtime did not measure it. */
  durationMs?: number | null;
  /* Milliseconds from the turn's start to its first call / first write; null when none was made, the start was not observed, or the row predates the column. */
  timeToFirstCallMs?: number | null;
  timeToFirstWriteMs?: number | null;
  /* Calls the runtime refused under a permission rule; null (never 0) when the turn was not measured. */
  deniedCallCount?: number | null;
  /* The turn's calls in order, each with a redacted, capped target; null when the turn was not measured. */
  toolSequence?: ToolSequenceEntry[] | null;
  /* What the turn spent over every step it finished. The tokens_* columns hold the usage of the last assistant message alone (what the blocking prompt answers with), so a many-step turn reads there as one step. Null when the steps were not all observed, none finished, or the row predates the column. */
  usageTotal?: TurnUsage | null;
  /* What the turn's trace mirrors. Written with the row and read back through `getAgentTurnTraces`; `getAgentTurns` (the public turn view) does not carry them. */
  /* The model the prompt asked for (null: the agent's configured one), the one that answered, its provider, the attempt that ended the turn (1 primary, 2 fallback) and whether the fallback answered. Null where the runtime cannot say or the row predates the column. */
  modelRequested?: string | null;
  modelAnswered?: string | null;
  provider?: string | null;
  attempt?: number | null;
  fallbackUsed?: boolean | null;
  /* The class of the last failure an attempt of the turn met. */
  errorType?: string | null;
  /* Byte sizes and sha256 of the prompt's sections, by section id, and the sha256 of the bytes sent. */
  sectionSizes?: Record<string, number> | null;
  sectionHashes?: Record<string, string> | null;
  promptHash?: string | null;
  /* The time limit that bound the prompt, and the limit that ended the turn. */
  limitApplied?: string | null;
  limitFired?: string | null;
}

/*
 * What a transport reports for one finished turn, as far as the history needs it: the shape every runtime's turn event has.
 * `outputText` is already sanitized by the transport that emitted the event.
 */
export interface AgentTurnEventInput {
  runId: string | null;
  sessionId: string;
  role: string;
  round: number;
  isRepair: boolean;
  ts: string;
  objective?: string | null;
  promptText: string;
  outputText: string;
  promptBytes: number;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  cost: number | null;
  stepBudget: { maxSteps: number | null; exhausted: boolean | null } | null;
  callMetrics: TurnCallMetrics | null;
  ended?: TurnEnd | null;
  /* Already redacted by the transport that emitted the event. */
  partialText?: string | null;
  durationMs: number | null;
  modelRequested?: string | null;
  modelAnswered?: string | null;
  provider?: string | null;
  attempt?: number | null;
  fallbackUsed?: boolean | null;
  errorType?: string | null;
  sectionSizes: Record<string, number> | null;
  sectionHashes?: Record<string, string> | null;
  promptHash?: string | null;
  limitApplied?: TimeLimitSource | null;
  limitFired?: TurnLimit | null;
}

/* One row of the span ledger. `startNs`/`endNs` are epoch nanoseconds. */
export interface RunSpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  runId: string | null;
  name: string;
  kind: string;
  startNs: bigint;
  endNs: bigint | null;
  status: string;
  statusMessage: string | null;
  /* JSON text. */
  attrs: string;
  events: string;
  links: string;
}

/* What a turn's trace mirrors, in the order of `getAgentTurns` for the same run (the rows are the same, by id). Separate from the public turn view, which does not carry it. Every field is null for a turn that carried none of it. */
export interface AgentTurnTraceRecord {
  sessionId: string;
  round: number;
  modelRequested: string | null;
  modelAnswered: string | null;
  provider: string | null;
  attempt: number | null;
  fallbackUsed: boolean | null;
  errorType: string | null;
  sectionSizes: Record<string, number> | null;
  sectionHashes: Record<string, string> | null;
  promptHash: string | null;
  limitApplied: string | null;
  limitFired: string | null;
}

/* What each turn of a run says about the role that ran it: the model asked for and the one that answered, its provider and the step limit the prompt stated. In turn order. */
export interface AgentRoleFacts {
  role: string;
  provider: string | null;
  modelRequested: string | null;
  modelAnswered: string | null;
  maxSteps: number | null;
}

/* The telemetry ledgers: run_spans (the span ledger) and agent_turns (one row per agent prompt/response cycle). */
export interface RecentTurnFigures {
  role: string;
  stepsUsed: number | null;
  promptBytes: number | null;
  tokensInput: number | null;
  tokensCacheRead: number | null;
}

export class TelemetryRepository {
  private readonly upsertSpan;
  private readonly spansOfRun;
  private readonly insertTurn;
  private readonly turnsOfRun;
  private readonly roleFacts;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.upsertSpan = raw.prepare(`
      INSERT INTO run_spans (trace_id, span_id, parent_span_id, run_id, name, kind, start_ns, end_ns, status, status_message, attrs, events, links)
      VALUES (@traceId, @spanId, @parentSpanId, @runId, @name, @kind, @startNs, @endNs, @status, @statusMessage, @attrs, @events, @links)
      ON CONFLICT(trace_id, span_id) DO UPDATE SET
        parent_span_id = excluded.parent_span_id, run_id = excluded.run_id, name = excluded.name, kind = excluded.kind,
        start_ns = excluded.start_ns, end_ns = excluded.end_ns, status = excluded.status, status_message = excluded.status_message,
        attrs = excluded.attrs, events = excluded.events, links = excluded.links`);
    this.spansOfRun = raw.prepare("SELECT * FROM run_spans WHERE run_id = ? ORDER BY start_ns, span_id").safeIntegers();
    this.insertTurn = raw.prepare(`
    INSERT INTO agent_turns
      (run_id, session_id, role, round, is_repair, ts, objective,
       prompt_text, output_text, prompt_bytes,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost,
       total_calls, steps_used, max_steps, calls_before_first_write, write_count,
       redundant_read_count, duplicate_call_count, prompt_provided_read_count, exhausted, call_buckets,
       path_provided_read_count, ended,
       duration_ms, time_to_first_call_ms, time_to_first_write_ms, denied_call_count, tool_sequence, usage_total,
       model_requested, model_answered, provider, attempt, fallback_used, error_type,
       section_sizes, section_hashes, prompt_hash, limit_applied, limit_fired, same_file_read_count, graph_provided_read_count, partial_text)
    VALUES
      (@runId, @sessionId, @role, @round, @isRepair, @ts, @objective,
       @promptText, @outputText, @promptBytes,
       @tokensInput, @tokensOutput, @tokensReasoning, @tokensCacheRead, @tokensCacheWrite, @cost,
       @totalCalls, @stepsUsed, @maxSteps, @callsBeforeFirstWrite, @writeCount,
       @redundantReadCount, @duplicateCallCount, @promptProvidedReadCount, @exhausted, @callBuckets,
       @pathProvidedReadCount, @ended,
       @durationMs, @timeToFirstCallMs, @timeToFirstWriteMs, @deniedCallCount, @toolSequence, @usageTotal,
       @modelRequested, @modelAnswered, @provider, @attempt, @fallbackUsed, @errorType,
       @sectionSizes, @sectionHashes, @promptHash, @limitApplied, @limitFired, @sameFileReadCount, @graphProvidedReadCount, @partialText)
  `);
    this.turnsOfRun = raw.prepare("SELECT * FROM agent_turns WHERE run_id = ? ORDER BY id ASC");
    this.roleFacts = raw.prepare("SELECT role, provider, model_requested, model_answered, max_steps FROM agent_turns WHERE run_id = ? ORDER BY id ASC");
  }

  /*
   * Upserts a batch of ledger rows in ONE transaction. A row carries every column, so an update of a span whose
   * start row was lost (a failed earlier batch) still lands complete.
   */
  commitRunSpans(rows: readonly RunSpanRow[]): void {
    this.db.write(() => {
      for (const row of rows) this.upsertSpan.run(row);
    });
  }

  listRunSpans(runId: string): RunSpanRow[] {
    const rows = this.spansOfRun.all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      traceId: r.trace_id as string,
      spanId: r.span_id as string,
      parentSpanId: (r.parent_span_id as string | null) ?? null,
      runId: (r.run_id as string | null) ?? null,
      name: r.name as string,
      kind: r.kind as string,
      startNs: r.start_ns as bigint,
      endNs: (r.end_ns as bigint | null) ?? null,
      status: r.status as string,
      statusMessage: (r.status_message as string | null) ?? null,
      attrs: r.attrs as string,
      events: r.events as string,
      links: r.links as string,
    }));
  }

  /*
   * Persist one agent turn. `output_text` and `partial_text` MUST already be sanitized by the caller
   * (the redaction port, or `sanitizeText` of the pattern redaction adapter) — this function stores whatever it receives.
   */
  saveAgentTurn(turn: AgentTurnRecord): void {
    this.db.write(() => this.insertTurn.run({
      runId: turn.runId ?? null,
      sessionId: turn.sessionId,
      role: turn.role,
      round: turn.round,
      isRepair: turn.isRepair ? 1 : 0,
      ts: turn.ts,
      objective: turn.objective ?? null,
      promptText: turn.promptText,
      outputText: turn.outputText,
      promptBytes: turn.promptBytes,
      tokensInput: turn.tokensInput ?? null,
      tokensOutput: turn.tokensOutput ?? null,
      tokensReasoning: turn.tokensReasoning ?? null,
      tokensCacheRead: turn.tokensCacheRead ?? null,
      tokensCacheWrite: turn.tokensCacheWrite ?? null,
      cost: turn.cost ?? null,
      totalCalls: turn.totalCalls ?? null,
      stepsUsed: turn.stepsUsed ?? null,
      maxSteps: turn.maxSteps ?? null,
      callsBeforeFirstWrite: turn.callsBeforeFirstWrite ?? null,
      writeCount: turn.writeCount ?? null,
      redundantReadCount: turn.redundantReadCount ?? null,
      sameFileReadCount: turn.sameFileReadCount ?? null,
      duplicateCallCount: turn.duplicateCallCount ?? null,
      promptProvidedReadCount: turn.promptProvidedReadCount ?? null,
      pathProvidedReadCount: turn.pathProvidedReadCount ?? null,
      graphProvidedReadCount: turn.graphProvidedReadCount ?? null,
      /* exhausted is tri-state: NULL = unknown, 0 = known not exhausted, 1 = exhausted. */
      exhausted: turn.exhausted == null ? null : turn.exhausted ? 1 : 0,
      callBuckets: turn.callBuckets ? JSON.stringify(turn.callBuckets) : null,
      ended: turn.ended ?? null,
      durationMs: turn.durationMs ?? null,
      timeToFirstCallMs: turn.timeToFirstCallMs ?? null,
      timeToFirstWriteMs: turn.timeToFirstWriteMs ?? null,
      deniedCallCount: turn.deniedCallCount ?? null,
      toolSequence: turn.toolSequence ? JSON.stringify(turn.toolSequence) : null,
      usageTotal: turn.usageTotal ? JSON.stringify(turn.usageTotal) : null,
      modelRequested: turn.modelRequested ?? null,
      modelAnswered: turn.modelAnswered ?? null,
      provider: turn.provider ?? null,
      attempt: turn.attempt ?? null,
      /* fallback_used is tri-state like exhausted: NULL = unknown. */
      fallbackUsed: turn.fallbackUsed == null ? null : turn.fallbackUsed ? 1 : 0,
      errorType: turn.errorType ?? null,
      sectionSizes: turn.sectionSizes ? JSON.stringify(turn.sectionSizes) : null,
      sectionHashes: turn.sectionHashes ? JSON.stringify(turn.sectionHashes) : null,
      promptHash: turn.promptHash ?? null,
      limitApplied: turn.limitApplied ?? null,
      limitFired: turn.limitFired ?? null,
      partialText: turn.partialText ?? null,
    }));
  }

  /*
   * The one place a transport's AgentTurnEvent becomes an agent_turns row, shared by every runtime
   * so a new column can never drift between runtimes. `output_text` is already sanitized
   * by the transport that emitted the event.
   */
  saveAgentTurnEvent(t: AgentTurnEventInput): void {
    this.saveAgentTurn({
      runId: t.runId,
      sessionId: t.sessionId,
      role: t.role,
      round: t.round,
      isRepair: t.isRepair,
      ts: t.ts,
      objective: t.objective ?? null,
      promptText: t.promptText,
      outputText: t.outputText,
      promptBytes: t.promptBytes,
      tokensInput: t.tokensInput,
      tokensOutput: t.tokensOutput,
      tokensReasoning: t.tokensReasoning,
      tokensCacheRead: t.tokensCacheRead,
      tokensCacheWrite: t.tokensCacheWrite,
      cost: t.cost,
      maxSteps: t.stepBudget?.maxSteps ?? null,
      exhausted: t.stepBudget ? t.stepBudget.exhausted : null,
      totalCalls: t.callMetrics?.totalCalls ?? null,
      stepsUsed: t.callMetrics?.stepsUsed ?? null,
      callsBeforeFirstWrite: t.callMetrics?.callsBeforeFirstWrite ?? null,
      writeCount: t.callMetrics?.writeCount ?? null,
      redundantReadCount: t.callMetrics?.redundantReadCount ?? null,
      sameFileReadCount: t.callMetrics?.sameFileReadCount ?? null,
      duplicateCallCount: t.callMetrics?.duplicateCallCount ?? null,
      promptProvidedReadCount: t.callMetrics?.promptProvidedReadCount ?? null,
      pathProvidedReadCount: t.callMetrics?.pathProvidedReadCount ?? null,
      graphProvidedReadCount: t.callMetrics?.graphProvidedReadCount ?? null,
      callBuckets: t.callMetrics?.buckets ?? null,
      ended: t.ended ?? null,
      durationMs: t.durationMs ?? null,
      timeToFirstCallMs: t.callMetrics?.timeToFirstCallMs ?? null,
      timeToFirstWriteMs: t.callMetrics?.timeToFirstWriteMs ?? null,
      deniedCallCount: t.callMetrics?.deniedCallCount ?? null,
      toolSequence: t.callMetrics?.toolSequence ?? null,
      usageTotal: t.callMetrics?.usage ?? null,
      modelRequested: t.modelRequested ?? null,
      modelAnswered: t.modelAnswered ?? null,
      provider: t.provider ?? null,
      attempt: t.attempt ?? null,
      fallbackUsed: t.fallbackUsed ?? null,
      errorType: t.errorType ?? null,
      sectionSizes: t.sectionSizes,
      sectionHashes: t.sectionHashes ?? null,
      promptHash: t.promptHash ?? null,
      limitApplied: t.limitApplied ?? null,
      limitFired: t.limitFired ?? null,
      partialText: t.partialText ?? null,
    });
  }



  /* Retrieve all agent turn records for a run, ordered by insertion (chronological). */
  getAgentTurns(runId: string): AgentTurnRecord[] {
    const rows = this.turnsOfRun.all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const site = (column: string) => ({ table: "agent_turns", column, id: String(r.id) });
      return {
      runId: (r.run_id as string | null) ?? null,
      sessionId: r.session_id as string,
      role: r.role as string,
      round: r.round as number,
      isRepair: Boolean(r.is_repair),
      ts: r.ts as string,
      objective: (r.objective as string | null) ?? null,
      promptText: r.prompt_text as string,
      outputText: r.output_text as string,
      promptBytes: r.prompt_bytes as number,
      tokensInput: (r.tokens_input as number | null) ?? null,
      tokensOutput: (r.tokens_output as number | null) ?? null,
      tokensReasoning: (r.tokens_reasoning as number | null) ?? null,
      tokensCacheRead: (r.tokens_cache_read as number | null) ?? null,
      tokensCacheWrite: (r.tokens_cache_write as number | null) ?? null,
      cost: (r.cost as number | null) ?? null,
      totalCalls: (r.total_calls as number | null) ?? null,
      stepsUsed: (r.steps_used as number | null) ?? null,
      maxSteps: (r.max_steps as number | null) ?? null,
      callsBeforeFirstWrite: (r.calls_before_first_write as number | null) ?? null,
      writeCount: (r.write_count as number | null) ?? null,
      redundantReadCount: (r.redundant_read_count as number | null) ?? null,
      sameFileReadCount: (r.same_file_read_count as number | null) ?? null,
      duplicateCallCount: (r.duplicate_call_count as number | null) ?? null,
      promptProvidedReadCount: (r.prompt_provided_read_count as number | null) ?? null,
      pathProvidedReadCount: (r.path_provided_read_count as number | null) ?? null,
      graphProvidedReadCount: (r.graph_provided_read_count as number | null) ?? null,
      exhausted: r.exhausted == null ? null : Boolean(r.exhausted),
      callBuckets: typeof r.call_buckets === "string" ? parseJsonColumn<Record<string, number> | null>(r.call_buckets, null, site("call_buckets")) : null,
      ended: (r.ended as TurnEnd | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      timeToFirstCallMs: (r.time_to_first_call_ms as number | null) ?? null,
      timeToFirstWriteMs: (r.time_to_first_write_ms as number | null) ?? null,
      deniedCallCount: (r.denied_call_count as number | null) ?? null,
      toolSequence: typeof r.tool_sequence === "string" ? toolSequenceOrNull(parseJsonColumn<unknown>(r.tool_sequence, null, site("tool_sequence"))) : null,
      usageTotal: typeof r.usage_total === "string" ? parseJsonColumn<TurnUsage | null>(r.usage_total, null, site("usage_total")) : null,
      partialText: (r.partial_text as string | null) ?? null,
    };
    });
  }

  /* The figures of the newest non-repair turns that recorded their steps, across runs: what the working room of a turn is estimated from. */
  getRecentTurnFigures(limit: number): RecentTurnFigures[] {
    const rows = this.db.raw
      .prepare("SELECT role, steps_used, prompt_bytes, tokens_input, tokens_cache_read FROM agent_turns WHERE steps_used IS NOT NULL AND is_repair = 0 ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      role: r.role as string,
      stepsUsed: (r.steps_used as number | null) ?? null,
      promptBytes: (r.prompt_bytes as number | null) ?? null,
      tokensInput: (r.tokens_input as number | null) ?? null,
      tokensCacheRead: (r.tokens_cache_read as number | null) ?? null,
    }));
  }

  getAgentRoleFacts(runId: string): AgentRoleFacts[] {
    const rows = this.roleFacts.all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      role: r.role as string,
      provider: (r.provider as string | null) ?? null,
      modelRequested: (r.model_requested as string | null) ?? null,
      modelAnswered: (r.model_answered as string | null) ?? null,
      maxSteps: (r.max_steps as number | null) ?? null,
    }));
  }

  getAgentTurnTraces(runId: string): AgentTurnTraceRecord[] {
    const rows = this.turnsOfRun.all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      round: r.round as number,
      modelRequested: (r.model_requested as string | null) ?? null,
      modelAnswered: (r.model_answered as string | null) ?? null,
      provider: (r.provider as string | null) ?? null,
      attempt: (r.attempt as number | null) ?? null,
      fallbackUsed: r.fallback_used == null ? null : Boolean(r.fallback_used),
      errorType: (r.error_type as string | null) ?? null,
      sectionSizes: typeof r.section_sizes === "string" ? parseJsonColumn<Record<string, number> | null>(r.section_sizes, null, { table: "agent_turns", column: "section_sizes", id: String(r.id) }) : null,
      sectionHashes: typeof r.section_hashes === "string" ? parseJsonColumn<Record<string, string> | null>(r.section_hashes, null, { table: "agent_turns", column: "section_hashes", id: String(r.id) }) : null,
      promptHash: (r.prompt_hash as string | null) ?? null,
      limitApplied: (r.limit_applied as string | null) ?? null,
      limitFired: (r.limit_fired as string | null) ?? null,
    }));
  }

  /* Per-role prompt sizes, cache use, reviewer convergence and efficiency over the app's turns and outcomes, optionally within the last `windowDays`. */
  computeTelemetryAnalysis(app: string, windowDays?: number): TelemetryAnalysis {
    return computeTelemetryAnalysis(this.db, app, windowDays);
  }
}

/* A stored sequence is only trusted as a list of entries; anything else reads as unknown. */
function toolSequenceOrNull(value: unknown): ToolSequenceEntry[] | null {
  return Array.isArray(value) ? (value as ToolSequenceEntry[]) : null;
}

/*
 * A corrupt row (exists but fails to parse) is a DISTINCT outcome from "no row yet" — returning
 * null for both let CurriculumPortAdapter.read() silently `initCurriculum` a corrupt app's
 * history, and the next successful fold() would persist that fresh curriculum right over the
 * corrupt row, permanently discarding whatever evidence it held with nothing logged anywhere.
 * CURRICULUM_CORRUPT routes the adapter's read() to throw instead, which its existing
 * try/catch (onError, no save) already fault-isolates — see curriculum-port.adapter.ts.
 */
