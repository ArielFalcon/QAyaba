/*
 * Spans of work that happens inside a run but is not the run's own control flow: a grounding source, a login attempt, a suite-store call,
 * a static check. Each is a child of the phase that is open, found through the run's exec scope (the phase cursor sets it), and is bound to
 * the run's secret scope, so a span started from a callback, a parallel promise or an adapter needs no ambient span.
 *
 * Observability never changes how a run ends: every function here is total. A fault is logged once and the work goes on untraced.
 */

import { activeExecScope } from "../process-sandbox/exec-scope.ts";
import { activeRunSecretScope } from "../run-secret-redaction.ts";
import { capItemIds, type ContextSource } from "../../contexts/generation/domain/context-item-ids.ts";
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
  truncated?: boolean;
  truncatedItems?: number;
  /* Items a delivered source left out (selection + truncation). */
  omitted?: number;
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
      ...record.attrs,
    });
    try {
      build?.(span);
    } finally {
      span.end();
    }
    guardTelemetry(telemetry).histogram("qayaba.context.bytes")(bytes, { "qayaba.context.source": record.source });
  } catch (err) {
    console.error(`[telemetry] a context span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}
