/*
 * Spans of work that happens inside a run but is not the run's own control flow: a grounding source, a login attempt, a suite-store call,
 * a static check. Each is a child of the phase that is open, found through the run's exec scope (the phase cursor sets it), and is bound to
 * the run's secret scope, so a span started from a callback, a parallel promise or an adapter needs no ambient span.
 *
 * Observability never changes how a run ends: every function here is total. A fault is logged once and the work goes on untraced.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { activeExecScope } from "../process-sandbox/exec-scope.ts";
import { activeRunSecretScope } from "../../shared-kernel/run-secret-redaction.ts";
import { capItemIds, type ContextSource } from "../../shared-kernel/context-item-ids.ts";
import { guardTelemetry } from "../../shared-kernel/telemetry/guarded-telemetry.ts";
import type { Attrs } from "../../shared-kernel/telemetry/attribute-registry.ts";
import type { SpanHandle, StartSpanOptions, TelemetryPort } from "../../shared-kernel/telemetry/telemetry.port.ts";

/* Where a child span of this run goes: under the open phase, redacted through the run's own secrets. Whatever cannot be found is left out and the span falls back to the active context. */
export function runChildOptions(): Pick<StartSpanOptions, "parent" | "secrets"> {
  let parent: ReturnType<NonNullable<NonNullable<ReturnType<typeof activeExecScope>>["telemetry"]>["parent"]>;
  try {
    parent = activeExecScope()?.telemetry?.parent();
  } catch {
    parent = undefined;
  }
  const secrets = activeRunSecretScope();
  return { ...(parent ? { parent } : {}), ...(secrets ? { secrets } : {}) };
}

/* Starts a child span of the open phase. */
export function startRunChildSpan(telemetry: TelemetryPort, name: string, attrs?: Attrs, extra: Omit<StartSpanOptions, "parent" | "secrets" | "attrs"> = {}): SpanHandle {
  return guardTelemetry(telemetry).startSpan(name, { kind: "internal", ...extra, ...runChildOptions(), ...(attrs ? { attrs } : {}) });
}

/* Runs `fn` between a child span's start and end; the span ends on return, on throw and on settlement of a promise, and the callback's own exception goes on unchanged. */
export function withRunChildSpan<T>(telemetry: TelemetryPort, name: string, attrs: Attrs | undefined, fn: (span: SpanHandle) => T): T {
  const guarded = guardTelemetry(telemetry);
  const span = guarded.startSpan(name, { kind: "internal", ...runChildOptions(), ...(attrs ? { attrs } : {}) });
  let result: T;
  try {
    result = fn(span);
  } catch (err) {
    span.end();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => span.end()) as T;
  }
  span.end();
  return result;
}

/* What a grounding source supplied. */
export interface ContextRecord {
  source: ContextSource;
  /* Stable ids of the items (context-item-ids.ts). */
  ids: readonly string[];
  /* Bytes the source contributed to what the agent receives. */
  bytes: number;
  /* produced (what a source supplied) or delivered (what the kept assembly actually gave the agent). */
  stage?: "produced" | "delivered";
  /* What a produced source came to, and why (closed sets: delivered|empty|skipped|failed). Degradation is a status, never a cut. */
  status?: "delivered" | "empty" | "skipped" | "failed";
  reason?: string;
  truncated?: boolean;
  truncatedItems?: number;
  /* Items a delivered source left out (selection + truncation). */
  omitted?: number;
  /* The per-reason omissions, for context_complete. Each becomes a `class:reason:count[:route]` string in the span. */
  omissions?: readonly { class: "selection" | "truncation"; reason: string; count: number; route?: string }[];
  /* Each cut, classed and with its closed reason, for the cut/cut_items metrics. */
  cuts?: readonly { class: "selection" | "truncation"; reason: string; count: number }[];
  /* Provenance/freshness (observe-only); stale is never derived from a cut. */
  freshness?: {
    location?: string;
    capturedAt?: string;
    capturedSha?: string;
    ageMs?: number;
    resultCount?: number;
    stale?: boolean;
    staleReason?: string;
    recapture?: string;
    domChanged?: boolean;
  };
  /* Item count when it differs from the ids (ids are deduplicated and capped). */
  count?: number;
  /* Extra attributes for the span. */
  attrs?: Attrs;
}

/* One `qayaba.context.<source>` span (produced) or `qayaba.delivered.<source>` (delivered): it starts and ends at once, since a source is a result and not an activity. Returns the span's handle (ended) so a caller can add events before it ends via `build`. */
export function recordContextSpan(telemetry: TelemetryPort, record: ContextRecord, build?: (span: SpanHandle) => void): void {
  try {
    const { ids, overflow } = capItemIds(record.ids);
    const stage = record.stage ?? "produced";
    const truncatedItems = record.truncatedItems ?? 0;
    const bytes = Math.max(0, Math.round(record.bytes));
    const span = startRunChildSpan(telemetry, `${stage === "delivered" ? "qayaba.delivered" : "qayaba.context"}.${record.source}`, {
      "qayaba.context.source": record.source,
      "qayaba.context.stage": stage,
      "qayaba.context.items.count": record.count ?? ids.length + overflow,
      "qayaba.context.bytes": bytes,
      "qayaba.context.truncated": record.truncated ?? truncatedItems > 0,
      "qayaba.context.truncated_items": truncatedItems,
      "qayaba.context.item_ids": ids,
      ...(overflow > 0 ? { "qayaba.context.item_ids.overflow": overflow } : {}),
      ...(record.omitted !== undefined && record.omitted > 0 ? { "qayaba.context.omitted": record.omitted } : {}),
      ...(record.omissions !== undefined && record.omissions.length > 0
        ? { "qayaba.context.omissions": record.omissions.slice(0, 200).map((o) => `${o.class}:${o.reason}:${o.count}${o.route !== undefined ? `:${o.route}` : ""}`) }
        : {}),
      ...(record.status !== undefined ? { "qayaba.context.status": record.status } : {}),
      ...(record.reason !== undefined ? { "qayaba.context.reason": record.reason } : {}),
      ...(record.freshness?.location !== undefined ? { "qayaba.context.location": record.freshness.location } : {}),
      ...(record.freshness?.capturedAt !== undefined ? { "qayaba.context.captured_at": record.freshness.capturedAt } : {}),
      ...(record.freshness?.capturedSha !== undefined ? { "qayaba.context.captured_sha": record.freshness.capturedSha } : {}),
      ...(record.freshness?.ageMs !== undefined ? { "qayaba.context.age_ms": record.freshness.ageMs } : {}),
      ...(record.freshness?.resultCount !== undefined ? { "qayaba.context.result_count": record.freshness.resultCount } : {}),
      ...(record.freshness?.stale !== undefined ? { "qayaba.context.stale": record.freshness.stale } : {}),
      ...(record.freshness?.staleReason !== undefined ? { "qayaba.context.stale_reason": record.freshness.staleReason } : {}),
      ...(record.freshness?.recapture !== undefined ? { "qayaba.context.recapture.outcome": record.freshness.recapture } : {}),
      ...(record.freshness?.domChanged !== undefined ? { "qayaba.context.dom_changed": record.freshness.domChanged } : {}),
      ...record.attrs,
    });
    try {
      build?.(span);
    } finally {
      span.end();
    }
    const guarded = guardTelemetry(telemetry);
    const items = record.count ?? ids.length + overflow;
    guarded.histogram("qayaba.context.bytes")(bytes, { "qayaba.context.source": record.source, "qayaba.context.stage": stage });
    guarded.histogram("qayaba.context.items")(items, { "qayaba.context.source": record.source, "qayaba.context.stage": stage });
    for (const cut of record.cuts ?? []) {
      const attrs = { "qayaba.context.source": record.source, "qayaba.context.cut_class": cut.class, "qayaba.context.cut_reason": cut.reason };
      guarded.counter("qayaba.context.cut")(1, attrs);
      guarded.histogram("qayaba.context.cut_items")(cut.count, attrs);
    }
    if (record.freshness) {
      if (record.freshness.ageMs !== undefined && record.freshness.ageMs >= 0) {
        guarded.histogram("qayaba.context.freshness.age")(record.freshness.ageMs, { "qayaba.context.source": record.source });
      }
      if (record.freshness.stale === true) {
        guarded.counter("qayaba.context.stale")(1, { "qayaba.context.source": record.source, "qayaba.context.stale_reason": record.freshness.staleReason ?? "none" });
      }
      if (record.freshness.recapture !== undefined) {
        guarded.counter("qayaba.context.recapture")(1, { "qayaba.context.source": record.source, "qayaba.context.recapture.outcome": record.freshness.recapture });
      }
    }
  } catch (err) {
    engineLog.error(`[telemetry] a context span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}
