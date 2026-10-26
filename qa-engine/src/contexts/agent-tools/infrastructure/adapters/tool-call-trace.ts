/*
 * A tool call the orchestrator serves for an agent (`run_spec`, the authenticated browser, the lead's code graph) as a SERVER span. The HTTP request
 * that brings a call in carries no trace context, and the port answers it inside a snapshot of the run's async context taken
 * during setup, which restores the OpenTelemetry context of that moment too (the `setup` phase, long ended). So the span is
 * opened here, explicitly parented on the attempt span of the session that called (the registry the turn decorator fills),
 * and the call runs under it: every sandboxed child it starts becomes a child of the call, a grandchild of the attempt.
 *
 * Observability never changes how a call ends: the call's result or exception is the caller's own, and every fault in the
 * trace is logged and dropped. A call is also recorded with its session, so the agent's own `execute_tool` span can link to it.
 */
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { GENAI } from "@kernel/telemetry/genai-semconv.ts";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import type { SpanHandle, TelemetryClock, TelemetryContext, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import { activeExecScope, openDeniedWindow, withExecScopeParent } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { activeRunSecretScope } from "../../../../shared-infrastructure/redaction/run-secret-redaction.ts";
import type { ToolAttemptDirectory } from "@contexts/generation/application/index.ts";

/* What the shell hands the adapters to trace the calls they serve. Absent: nothing is traced. */
export interface ToolTraceWiring {
  telemetry: TelemetryPort;
  clock: TelemetryClock;
  /* Which attempt a session's calls hang under, and where a served call is remembered for the link. Absent: the phase that is open. */
  attempts?: ToolAttemptDirectory;
}

export interface ToolCallTrace {
  /* The span's name, `qayaba.tool.<tool>`. */
  span: "qayaba.tool.run_spec" | "qayaba.tool.authbrowser" | "qayaba.tool.codegraph";
  /* The agent-side tool name the runtime reports for the call, which the synthesized span carries: `run_spec`, `authbrowser_navigate`... */
  tool: string;
  sessionId: string;
  messageId: string | undefined;
}

/* What a call tells its span while it runs. */
export interface ToolObserver {
  setAttrs(attrs: Attrs): void;
}

const NO_OBSERVER: ToolObserver = { setAttrs: () => {} };

function quietly<T>(label: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    console.error(`[qa] tool call telemetry (${label}) failed and was dropped: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/*
 * Runs `serve` under the call's span. `describe` turns the answer into the attributes that say how it ended. Without a wiring the
 * call runs bare.
 */
export function traceToolCall<T>(
  wiring: ToolTraceWiring | undefined,
  trace: ToolCallTrace,
  serve: (observer: ToolObserver) => Promise<T>,
  describe: (answer: T) => Attrs,
): Promise<T> {
  if (!wiring) return serve(NO_OBSERVER);
  const telemetry = guardTelemetry(wiring.telemetry);
  const parent: SpanHandle | TelemetryContext | undefined = quietly("parent", undefined, () => wiring.attempts?.attemptSpan(trace.sessionId) ?? activeExecScope()?.telemetry?.parent());
  const secrets = quietly("secrets", undefined, () => activeRunSecretScope());
  const startedAt = quietly("clock", Date.now(), () => wiring.clock.now());
  return telemetry.withSpan(
    trace.span,
    {
      kind: "server",
      startTime: startedAt,
      ...(parent ? { parent } : {}),
      ...(secrets ? { secrets } : {}),
      attrs: {
        [GENAI.attrs.toolName]: trace.tool,
        [GENAI.attrs.conversationId]: trace.sessionId,
        ...(trace.messageId !== undefined ? { "qayaba.tool.message_id": trace.messageId } : {}),
      },
    },
    async (span) => {
      const window = quietly("denied window", undefined, () => openDeniedWindow());
      const observer: ToolObserver = { setAttrs: (attrs) => span.setAttrs(attrs) };
      try {
        const answer = await withExecScopeParent(span.context(), () => serve(observer), { startedAt, annotate: (attrs) => span.setAttrs(attrs) });
        quietly("outcome", undefined, () => span.setAttrs(describe(answer)));
        return answer;
      } finally {
        quietly("close", undefined, () => {
          const hosts = window?.hosts() ?? [];
          window?.close();
          if (hosts.length > 0) span.setAttrs({ "qayaba.egress.denied_cotemporal": hosts });
          wiring.attempts?.noteToolCall(trace.sessionId, {
            tool: trace.tool,
            ...(trace.messageId !== undefined ? { messageId: trace.messageId } : {}),
            startedAt,
            endedAt: wiring.clock.now(),
            context: span.context(),
          });
        });
      }
    },
  );
}
