/* The span ledger: a SpanProcessor that mirrors every span into `run_spans` in the history database (docs/observability-design.md §3.3). Metadata only and local: it works when no collector ran, so retroactive graders and the public API never depend on one.

   Write path. A synchronous insert per span would put an fsync on the event loop. Changes (a span starting, a span ending) are buffered in memory and committed in one transaction every `flushEvery` changes, on `flush()` (the run calls it on a phase change) and on shutdown. A row is written when its span starts, with no end, and updated when it ends, so a hung run is visible while it hangs and a crashed one leaves its open spans behind. A span that starts and ends between two flushes is written once, complete. Every row carries every column, so an update lands in full even when the start row was lost to a failed batch. A failed batch is counted and dropped: the ledger never throws into a run.

   Run id. Taken from the span's own `qayaba.run.id` attribute at start, else inherited from the parent's row, and re-checked at end (an attribute set late). */

import type { Context } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SpanKind } from "@opentelemetry/api";
import type { HrTime } from "@opentelemetry/api";
import type { RunSpanRow } from "../server/persistence/repositories/telemetry.repository";

export interface RunSpanStore {
  commit(rows: readonly RunSpanRow[]): void;
  /* Drops expired rows in a bounded chunk. Called from the flush path, at most once per PRUNE_EVERY_MS. */
  prune?(nowMs: number): void;
}

export interface LedgerOptions {
  /* Buffered changes that trigger a commit. */
  readonly flushEvery?: number;
  /* Wall-clock ms, for the prune cadence. */
  readonly now?: () => number;
}

export interface LedgerStats {
  readonly ok: boolean;
  /* Rows committed (a span updated at its end counts once more). */
  readonly spans: number;
  readonly writeErrors: number;
}

export const DEFAULT_FLUSH_EVERY = 200;
const RUN_ID_ATTRIBUTE = "qayaba.run.id";
/* Traces whose root has not ended; a generous safety cap that evicts the least recently used trace. */
const MAX_TRACKED_TRACES = 10_000;
/* Rows kept for retry after failed batches, in multiples of the batch size. */
const RETAINED_BATCHES = 10;
export const PRUNE_EVERY_MS = 60 * 60 * 1000;

const KIND_NAMES: Record<number, string> = {
  [SpanKind.INTERNAL]: "internal",
  [SpanKind.SERVER]: "server",
  [SpanKind.CLIENT]: "client",
  [SpanKind.PRODUCER]: "producer",
  [SpanKind.CONSUMER]: "consumer",
};
const STATUS_NAMES: Record<number, string> = {
  [SpanStatusCode.UNSET]: "unset",
  [SpanStatusCode.OK]: "ok",
  [SpanStatusCode.ERROR]: "error",
};

const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const hrToNs = (t: HrTime): bigint => BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);

function toRow(span: ReadableSpan, runId: string | null, ended: boolean): RunSpanRow {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    runId,
    name: span.name,
    kind: KIND_NAMES[span.kind] ?? "internal",
    startNs: hrToNs(span.startTime),
    endNs: ended ? maxBigInt(hrToNs(span.endTime), hrToNs(span.startTime)) : null,
    status: STATUS_NAMES[span.status.code] ?? "unset",
    statusMessage: span.status.message ?? null,
    attrs: JSON.stringify(span.attributes),
    events: JSON.stringify(span.events.map((e) => ({ name: e.name, timeNs: hrToNs(e.time).toString(), attrs: e.attributes ?? {} }))),
    links: JSON.stringify(span.links.map((l) => ({ traceId: l.context.traceId, spanId: l.context.spanId, attrs: l.attributes ?? {} }))),
  };
}

const key = (traceId: string, spanId: string): string => `${traceId}:${spanId}`;

export class LedgerSpanProcessor implements SpanProcessor {
  private readonly pending = new Map<string, RunSpanRow>();
  /* One trace is one run: trace id to run id, in least-recently-used order. */
  private readonly runIds = new Map<string, string>();
  private lastPruneAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private changes = 0;
  private committed = 0;
  private writeErrors = 0;
  private lastWriteOk = true;
  private readonly flushEvery: number;

  constructor(private readonly store: RunSpanStore, opts: LedgerOptions = {}) {
    this.flushEvery = opts.flushEvery ?? DEFAULT_FLUSH_EVERY;
    this.now = opts.now ?? Date.now;
  }

  onStart(span: Span, _parentContext: Context): void {
    try {
      const ctx = span.spanContext();
      const runId = this.resolveRunId(span);
      this.pending.set(key(ctx.traceId, ctx.spanId), toRow(span, runId, false));
      this.noteChange();
    } catch (error) {
      this.countFault(error);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const ctx = span.spanContext();
      const runId = this.resolveRunId(span);
      this.pending.set(key(ctx.traceId, ctx.spanId), toRow(span, runId, true));
      /* The root ending releases the trace's run id, after its own row is queued. */
      if (span.parentSpanContext === undefined) this.runIds.delete(ctx.traceId);
      this.noteChange();
    } catch (error) {
      this.countFault(error);
    }
  }

  /* Commits everything buffered, in one transaction. Never throws. A failed batch is re-queued (never over a newer row) up to a cap. */
  flush(): void {
    if (this.pending.size === 0) {
      this.changes = 0;
    } else {
      const rows = [...this.pending.values()];
      this.pending.clear();
      this.changes = 0;
      try {
        this.store.commit(rows);
        this.committed += rows.length;
        this.lastWriteOk = true;
      } catch (error) {
        this.countFault(error);
        this.requeue(rows);
      }
    }
    this.pruneIfDue();
  }

  forceFlush(): Promise<void> {
    this.flush();
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.flush();
    return Promise.resolve();
  }

  stats(): LedgerStats {
    return { ok: this.lastWriteOk, spans: this.committed, writeErrors: this.writeErrors };
  }

  private resolveRunId(span: ReadableSpan): string | null {
    const traceId = span.spanContext().traceId;
    const own = span.attributes[RUN_ID_ATTRIBUTE];
    if (typeof own === "string" && own !== "") {
      this.touchRunId(traceId, own);
      return own;
    }
    const known = this.runIds.get(traceId);
    if (known === undefined) return null;
    this.touchRunId(traceId, known);
    return known;
  }

  /* Sets the trace's run id and marks it most recently used; evicts the least recently used past the cap. */
  private touchRunId(traceId: string, runId: string): void {
    this.runIds.delete(traceId);
    this.runIds.set(traceId, runId);
    if (this.runIds.size > MAX_TRACKED_TRACES) {
      const oldest = this.runIds.keys().next().value;
      if (oldest !== undefined) this.runIds.delete(oldest);
    }
  }

  private requeue(rows: readonly RunSpanRow[]): void {
    for (const row of rows) {
      const k = key(row.traceId, row.spanId);
      if (!this.pending.has(k)) this.pending.set(k, row);
    }
    const cap = this.flushEvery * RETAINED_BATCHES;
    while (this.pending.size > cap) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
      this.writeErrors += 1;
    }
  }

  private pruneIfDue(): void {
    if (!this.store.prune) return;
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    try {
      this.store.prune(now);
    } catch (error) {
      this.countFault(error);
    }
  }

  private noteChange(): void {
    this.changes += 1;
    if (this.changes >= this.flushEvery) this.flush();
  }

  private countFault(error: unknown): void {
    this.writeErrors += 1;
    this.lastWriteOk = false;
    console.error(`[telemetry] span ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
