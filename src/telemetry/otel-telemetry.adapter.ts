/* The TelemetryPort over the OpenTelemetry API: the only implementation of the engine's tracing seam, and with bootstrap.ts and ledger.ts the only code that imports `@opentelemetry/*`.

   Rules it enforces:
   - One clock. Every span starts and ends at wall-clock times from the injected clock (or an explicit time from the caller), never the SDK's monotonic delta, so native and synthesized spans agree across a host suspend.
   - Attribute policy. A key outside the registry is dropped and counted. A key classed `redacted-text` or `content` is redacted through the span's bound RedactionScope (not whatever async context is active) and then the outbound sanitizer, and capped; `content` keys leave only in `full` capture, text keys never in `off`. Status descriptions and exception messages are text too; a stack trace is never recorded. If redaction itself fails, the attribute is dropped, never sent raw.
   - Totality. No method throws into the caller: a fault is counted and swallowed, and a callback given to withSpan/withParent always runs. Only the callback's own exception propagates. */

import { appLogger } from "../integrations/redacting-logger";
import {
  ROOT_CONTEXT,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  TraceFlags,
  createContextKey,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type ContextManager,
  type HrTime,
  type Link,
  type Meter,
  type Span,
  type SpanContext,
  type Tracer,
} from "@opentelemetry/api";
import { lookupAttribute, type AttrSpec } from "@kernel/telemetry/attribute-registry";
import { INSTRUMENTS, type InstrumentTable } from "./instrument-table";
import type { RecordMeasurement, RedactionScope, SpanHandle, SpanKind, StartSpanOptions, TelemetryClock, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { sanitizeText } from "../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";

import { capCaptureMode, isCaptureMode, DEFAULT_CAPTURE_MODE, type CaptureMode } from "@kernel/telemetry/capture-mode";

export type { CaptureMode };

export interface OtelTelemetryDeps {
  readonly tracer: Tracer;
  /* The same manager the provider is registered with, used directly so nothing depends on global API state. */
  readonly contextManager: ContextManager;
  readonly clock: TelemetryClock;
  /* The mode of a span that is not in a run that chose its own. Default: metadata. */
  readonly captureMode?: CaptureMode;
  /* The most content any span may carry, whatever a run asks for (QA_TELEMETRY_MAX_CAPTURE). Default: full, so only a configured server narrows it. */
  readonly maxCaptureMode?: CaptureMode;
  /* Absent: instruments record nothing. */
  readonly meter?: Meter;
  readonly instruments?: InstrumentTable;
  /* The outbound sanitizer. Default: `sanitizeText` of the pattern redaction adapter, in its "issue" mode. */
  readonly sanitize?: (text: string) => string;
  /* Commits buffered local records (the span ledger). */
  readonly flush?: () => void;
}

export interface TelemetryAdapterStats {
  readonly droppedAttributes: number;
  readonly droppedMeasurements: number;
  readonly faults: number;
}

/* Free text (error messages, tool targets) and message bodies are capped after redaction. */
export const TEXT_CAP_CHARS = 1024;
export const CONTENT_CAP_CHARS = 32 * 1024;
/* Caps for the structure of a span: plain string values, array lengths, names, error classes and metric attribute values. */
export const NONE_CAP_CHARS = 256;
export const ARRAY_CAP = 64;
export const NAME_CAP_CHARS = 128;
export const ERROR_TYPE_CAP_CHARS = 128;
export const METRIC_VALUE_CAP_CHARS = 64;
const MAX_FAULT_LOGS = 5;

const SCOPE_KEY = createContextKey("qayaba.redaction-scope");
/* The capture mode of the run a span belongs to: set where the run's root is opened and inherited by every span under it, like the redaction scope. */
const CAPTURE_KEY = createContextKey("qayaba.capture-mode");
const ZERO_TRACE = "00000000000000000000000000000000";
const ZERO_SPAN = "0000000000000000";

const KINDS: Record<SpanKind, OtelSpanKind> = {
  internal: OtelSpanKind.INTERNAL,
  server: OtelSpanKind.SERVER,
  client: OtelSpanKind.CLIENT,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER,
};

/* Wall-clock ms to an HrTime. Always an explicit HrTime: the SDK reads a bare number below half of performance.timeOrigin as a monotonic reading. */
export function toHrTime(ms: number): HrTime {
  let seconds = Math.trunc(ms / 1000);
  let nanos = Math.round((ms - seconds * 1000) * 1e6);
  if (nanos >= 1e9) {
    seconds += 1;
    nanos -= 1e9;
  }
  return [seconds, nanos];
}

interface Resolved {
  readonly otelCtx: Context;
}

const DEAD_CONTEXT: TelemetryContext = Object.freeze({ traceId: ZERO_TRACE, spanId: ZERO_SPAN });

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

/* The JavaScript typeof of a registry type's elements. */
function elementType(spec: AttrSpec): string {
  if (spec.type === "string" || spec.type === "string[]") return "string";
  return spec.type === "boolean" ? "boolean" : "number";
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name || "Error";
  return "unknown";
}
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export class OtelTelemetry implements TelemetryPort {
  private readonly captureMode: CaptureMode;
  private readonly maxCaptureMode: CaptureMode;
  private readonly instruments: InstrumentTable;
  private readonly sanitize: (text: string) => string;
  private readonly resolved = new WeakMap<object, Resolved>();
  /* Roots (`root: true`) started and not yet ended, by span id: a run's root stays here while its phases run. */
  private readonly openRoots = new Map<string, Context>();
  private readonly instrumentCache = new Map<string, (value: number, attrs?: Attributes) => void>();
  private droppedAttributes = 0;
  private droppedMeasurements = 0;
  private faults = 0;

  constructor(private readonly deps: OtelTelemetryDeps) {
    this.maxCaptureMode = deps.maxCaptureMode ?? "full";
    this.captureMode = capCaptureMode(deps.captureMode ?? DEFAULT_CAPTURE_MODE, this.maxCaptureMode);
    this.instruments = deps.instruments ?? INSTRUMENTS;
    this.sanitize = deps.sanitize ?? ((text) => sanitizeText(text, "issue").text);
  }

  stats(): TelemetryAdapterStats {
    return { droppedAttributes: this.droppedAttributes, droppedMeasurements: this.droppedMeasurements, faults: this.faults };
  }

  startSpan(name: string, opts: StartSpanOptions = {}): SpanHandle {
    try {
      const parentCtx = this.parentContext(opts);
      const scope = opts.secrets ?? (parentCtx.getValue(SCOPE_KEY) as RedactionScope | undefined);
      const inherited = parentCtx.getValue(CAPTURE_KEY);
      /* A span names its own mode (the run's root does), or takes its parent's; neither may exceed the server's ceiling. */
      const capture = capCaptureMode(opts.captureMode ?? (isCaptureMode(inherited) ? inherited : this.captureMode), this.maxCaptureMode);
      const links: Link[] = [];
      for (const link of opts.links ?? []) {
        const context = this.spanContextOf(link.context);
        if (context) links.push({ context, attributes: this.filterAttrs(link.attrs, scope, capture) });
      }
      const span = this.deps.tracer.startSpan(
        this.safeName(name, scope),
        {
          kind: KINDS[opts.kind ?? "internal"],
          startTime: this.hr(opts.startTime),
          attributes: this.filterAttrs(opts.attrs, scope, capture),
          links,
          ...(opts.root ? { root: true } : {}),
        },
        parentCtx,
      );
      const spanContext = span.spanContext();
      let otelCtx = trace.setSpan(parentCtx, span);
      if (scope) otelCtx = otelCtx.setValue(SCOPE_KEY, scope);
      otelCtx = otelCtx.setValue(CAPTURE_KEY, capture);
      if (opts.root) this.openRoots.set(spanContext.spanId, otelCtx);
      return new Handle(this, span, { traceId: spanContext.traceId, spanId: spanContext.spanId }, otelCtx, scope, capture);
    } catch (error) {
      this.fault("startSpan", error);
      return new DeadHandle();
    }
  }

  withSpan<T>(name: string, opts: StartSpanOptions, fn: (span: SpanHandle) => T): T {
    const span = this.startSpan(name, opts);
    const ctx = this.resolved.get(span)?.otelCtx ?? this.activeOrRoot();
    return this.run(ctx, () => {
      let result: T;
      try {
        result = fn(span);
      } catch (error) {
        span.recordError(error);
        span.end();
        throw error;
      }
      if (isThenable(result)) {
        return result.then(
          (value) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            span.recordError(error);
            span.end();
            throw error;
          },
        ) as T;
      }
      span.end();
      return result;
    });
  }

  withParent<T>(parent: SpanHandle | TelemetryContext, fn: () => T): T {
    const resolved = this.resolve(parent);
    return resolved ? this.run(resolved.otelCtx, fn) : fn();
  }

  activeContext(): TelemetryContext | undefined {
    try {
      const otelCtx = this.deps.contextManager.active();
      const span = trace.getSpan(otelCtx);
      if (!span) return undefined;
      const spanContext = span.spanContext();
      if (!trace.isSpanContextValid(spanContext)) return undefined;
      const context: TelemetryContext = { traceId: spanContext.traceId, spanId: spanContext.spanId };
      this.resolved.set(context, { otelCtx });
      return context;
    } catch (error) {
      this.fault("activeContext", error);
      return undefined;
    }
  }

  /* Where a log record belongs: the ambient span's context, else the run root that is open. A run's phases and its engine
     callbacks often run with no ambient span (a phase span is never made ambient), so the single open root stands in for
     them; with none or several open a record has no run to join. The mode decides whether and how much leaves, the
     context carries the trace and span ids into the record. */
  logTarget(): { mode: CaptureMode; context: Context } | undefined {
    try {
      const ambient = this.deps.contextManager.active();
      const ctx = trace.getSpan(ambient) ? ambient : this.openRoots.size === 1 ? [...this.openRoots.values()][0] : undefined;
      if (ctx === undefined) return undefined;
      const inherited = ctx.getValue(CAPTURE_KEY);
      return { mode: isCaptureMode(inherited) ? inherited : this.captureMode, context: ctx };
    } catch (error) {
      this.fault("logTarget", error);
      return undefined;
    }
  }

  /* The capture mode of a record that belongs to no run (a warning at boot). */
  get processCaptureMode(): CaptureMode {
    return this.captureMode;
  }

  /* Redact and cap a log line through the run scope held by `context`, then the outbound sanitizer. undefined: do not export. */
  redactIn(context: Context | undefined, text: string, cap: number): string | undefined {
    try {
      return this.safeText(text, context?.getValue(SCOPE_KEY) as RedactionScope | undefined, cap);
    } catch (error) {
      this.fault("redactIn", error);
      return undefined;
    }
  }

  flush(): void {
    try {
      this.deps.flush?.();
    } catch (error) {
      this.fault("flush", error);
    }
  }

  counter(name: string): RecordMeasurement {
    return this.instrument(name, "counter");
  }

  histogram(name: string): RecordMeasurement {
    return this.instrument(name, "histogram");
  }

  gauge(name: string): RecordMeasurement {
    return this.instrument(name, "gauge");
  }

  /* ---- used by Handle ---- */

  closeRoot(spanId: string): void {
    this.openRoots.delete(spanId);
  }

  register(object: object, otelCtx: Context): void {
    this.resolved.set(object, { otelCtx });
  }

  /* Wall-clock ms to an HrTime; a missing or non-finite time is the clock's now. */
  hr(ms: number | undefined): HrTime {
    return toHrTime(ms !== undefined && Number.isFinite(ms) ? ms : this.deps.clock.now());
  }

  /* A span or event name: redacted, sanitized and capped. A failed redaction yields a fixed placeholder, never the raw name. */
  safeName(name: string, scope: RedactionScope | undefined): string {
    try {
      return this.redactText(name, scope, NAME_CAP_CHARS);
    } catch (error) {
      this.fault("name", error);
      return "unnamed";
    }
  }

  filterAttrs(attrs: object | undefined, scope: RedactionScope | undefined, capture: CaptureMode = this.captureMode): Attributes {
    const out: Attributes = {};
    if (!attrs) return out;
    for (const [key, value] of Object.entries(attrs) as Array<[string, unknown]>) {
      if (value === undefined) continue;
      try {
        const spec = lookupAttribute(key);
        if (!spec || !this.allows(spec, capture)) {
          this.droppedAttributes += 1;
          continue;
        }
        const converted = this.convert(value, spec, scope);
        if (converted === undefined) {
          this.droppedAttributes += 1;
          continue;
        }
        out[key] = converted;
      } catch (error) {
        /* A failed redaction drops the attribute: the raw value is never sent. */
        this.droppedAttributes += 1;
        this.fault("attribute", error);
      }
    }
    return out;
  }

  /* Redacted and capped text for a status description or an exception message. Returns undefined when redaction fails. */
  safeText(text: string, scope: RedactionScope | undefined, cap: number = TEXT_CAP_CHARS): string | undefined {
    try {
      return this.redactText(text, scope, cap);
    } catch (error) {
      this.fault("redaction", error);
      return undefined;
    }
  }

  fault(where: string, error: unknown): void {
    this.faults += 1;
    if (this.faults <= MAX_FAULT_LOGS) {
      appLogger.error(`[telemetry] ${where} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /* ---- internals ---- */

  private allows(spec: AttrSpec, capture: CaptureMode): boolean {
    if (capture === "full") return true;
    if (capture === "metadata") return spec.content !== "content";
    return spec.content === "none";
  }

  private redactText(text: string, scope: RedactionScope | undefined, cap: number): string {
    const redacted = this.sanitize(scope ? scope.redact(text) : text);
    return redacted.length > cap ? redacted.slice(0, cap) : redacted;
  }

  private convert(value: unknown, spec: AttrSpec, scope: RedactionScope | undefined): AttributeValue | undefined {
    if (spec.content === "none" || spec.content === "metadata") {
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      if (typeof value === "boolean") return value;
      /* Structural strings are not pattern-sanitized (an id or enum would be corrupted), but the run's own known secrets are removed by value. */
      if (typeof value === "string") return this.byValue(value, scope);
      if (Array.isArray(value)) {
        const items = value.slice(0, spec.arrayCap ?? ARRAY_CAP);
        if (!items.every((v) => typeof v === elementType(spec))) return undefined;
        return (typeof items[0] === "string" ? items.map((v) => this.byValue(v as string, scope)) : items) as AttributeValue;
      }
      return undefined;
    }
    const cap = spec.content === "content" ? CONTENT_CAP_CHARS : TEXT_CAP_CHARS;
    if (Array.isArray(value)) return value.slice(0, spec.arrayCap ?? ARRAY_CAP).map((v) => this.redactText(String(v), scope, cap));
    return this.redactText(String(value), scope, cap);
  }

  private byValue(text: string, scope: RedactionScope | undefined): string {
    const redacted = scope ? scope.redact(text) : text;
    return redacted.length > NONE_CAP_CHARS ? redacted.slice(0, NONE_CAP_CHARS) : redacted;
  }

  private activeOrRoot(): Context {
    try {
      return this.deps.contextManager.active();
    } catch (error) {
      this.fault("active", error);
      return ROOT_CONTEXT;
    }
  }

  private parentContext(opts: StartSpanOptions): Context {
    if (opts.root) return ROOT_CONTEXT;
    if (opts.parent) {
      const resolved = this.resolve(opts.parent);
      if (resolved) return resolved.otelCtx;
    }
    return this.activeOrRoot();
  }

  private resolve(parent: SpanHandle | TelemetryContext): Resolved | undefined {
    const known = this.resolved.get(parent);
    if (known) return known;
    const context = "context" in parent && typeof parent.context === "function" ? parent.context() : (parent as TelemetryContext);
    const knownContext = this.resolved.get(context);
    if (knownContext) return knownContext;
    const remote = this.remoteSpanContext(context);
    return remote ? { otelCtx: trace.setSpanContext(ROOT_CONTEXT, remote) } : undefined;
  }

  private remoteSpanContext(context: TelemetryContext): SpanContext | undefined {
    if (context.traceId === ZERO_TRACE || context.spanId === ZERO_SPAN) return undefined;
    const spanContext: SpanContext = { traceId: context.traceId, spanId: context.spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true };
    return trace.isSpanContextValid(spanContext) ? spanContext : undefined;
  }

  private spanContextOf(context: TelemetryContext): SpanContext | undefined {
    const known = this.resolved.get(context);
    const fromKnown = known ? trace.getSpanContext(known.otelCtx) : undefined;
    return fromKnown ?? this.remoteSpanContext(context);
  }

  private run<T>(ctx: Context, fn: () => T): T {
    let entered = false;
    try {
      return this.deps.contextManager.with(ctx, () => {
        entered = true;
        return fn();
      });
    } catch (error) {
      if (entered) throw error;
      this.fault("context", error);
      return fn();
    }
  }

  private instrument(name: string, type: "counter" | "histogram" | "gauge"): RecordMeasurement {
    const noop: RecordMeasurement = () => {};
    const declared = this.instruments[name];
    if (!declared || declared.type !== type) {
      this.droppedMeasurements += 1;
      return noop;
    }
    const allowed = new Set<string>(declared.attrs);
    const cacheKey = `${type}:${name}`;
    return (value, attrs) => {
      try {
        if (!this.deps.meter) return;
        if (!Number.isFinite(value) || (type === "counter" && value < 0)) {
          this.droppedMeasurements += 1;
          return;
        }
        let record = this.instrumentCache.get(cacheKey);
        if (!record) {
          const meter = this.deps.meter;
          if (type === "counter") {
            const counter = meter.createCounter(name);
            record = (v, a) => counter.add(v, a);
          } else if (type === "gauge") {
            const gauge = meter.createGauge(name);
            record = (v, a) => gauge.record(v, a);
          } else {
            const histogram = meter.createHistogram(name);
            record = (v, a) => histogram.record(v, a);
          }
          this.instrumentCache.set(cacheKey, record);
        }
        const kept: Attributes = {};
        for (const [key, v] of Object.entries(attrs ?? {}) as Array<[string, unknown]>) {
          if (v === undefined) continue;
          if (!allowed.has(key) || !(typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
            this.droppedAttributes += 1;
            continue;
          }
          kept[key] = typeof v === "string" && v.length > METRIC_VALUE_CAP_CHARS ? v.slice(0, METRIC_VALUE_CAP_CHARS) : v;
        }
        record(value, kept);
      } catch (error) {
        this.fault("measurement", error);
      }
    };
  }
}

class DeadHandle implements SpanHandle {
  setAttrs(): void {}
  addEvent(): void {}
  recordError(): void {}
  end(): void {}
  context(): TelemetryContext {
    return DEAD_CONTEXT;
  }
}

class Handle implements SpanHandle {
  private ended = false;

  constructor(
    private readonly owner: OtelTelemetry,
    private readonly span: Span,
    private readonly ids: TelemetryContext,
    otelCtx: Context,
    private readonly scope: RedactionScope | undefined,
    private readonly capture: CaptureMode,
  ) {
    owner.register(this, otelCtx);
    owner.register(ids, otelCtx);
  }

  setAttrs(attrs: object): void {
    try {
      this.span.setAttributes(this.owner.filterAttrs(attrs, this.scope, this.capture));
    } catch (error) {
      this.owner.fault("setAttrs", error);
    }
  }

  addEvent(name: string, attrs?: object, time?: number): void {
    try {
      this.span.addEvent(this.owner.safeName(name, this.scope), this.owner.filterAttrs(attrs, this.scope, this.capture), this.owner.hr(time));
    } catch (error) {
      this.owner.fault("addEvent", error);
    }
  }

  recordError(error: unknown, attrs?: object, time?: number): void {
    try {
      const type = this.owner.safeText(errorType(error), this.scope, ERROR_TYPE_CAP_CHARS) ?? "unknown";
      const message = this.owner.safeText(errorText(error), this.scope);
      const merged: Record<string, unknown> = { "error.type": type, ...(attrs ?? {}) };
      this.span.setAttributes(this.owner.filterAttrs(merged, this.scope, this.capture));
      this.span.addEvent(
        "exception",
        this.owner.filterAttrs({ "exception.type": type, ...(message === undefined ? {} : { "exception.message": message }) }, this.scope, this.capture),
        this.owner.hr(time),
      );
      this.span.setStatus(message === undefined ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.ERROR, message });
    } catch (fault) {
      this.owner.fault("recordError", fault);
    }
  }

  end(endTime?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.owner.closeRoot(this.ids.spanId);
    try {
      this.span.end(this.owner.hr(endTime));
    } catch (error) {
      this.owner.fault("end", error);
    }
  }

  context(): TelemetryContext {
    return this.ids;
  }
}
