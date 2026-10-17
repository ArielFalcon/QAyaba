/* A Codex prompt as a trace: the real strategy over a fake transport, the real turn decorator and the real telemetry adapter over an in-memory exporter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AgentTimeoutError, AgentUnavailableError } from "../errors";
import { classifyCodexFault, codexErrorToInfra, CodexRuntimeStrategy, type CodexHeadlessTransport, type CodexTransportPromptOpts } from "../agent-runtime/codex-strategy";
import { resetCodexCircuit } from "../integrations/codex-circuit-breaker";
import { roleForLegacyAgent } from "../agent-runtime/types";
import type { AgentDeps, AgentTurnEvent } from "../integrations/opencode-client";
import { withTurnTelemetry } from "@contexts/generation/infrastructure/telemetry/with-turn-telemetry";
import { AgentTurnTraces } from "@contexts/generation/infrastructure/telemetry/turn-trace-registry";
import type { StepIntentContext } from "@contexts/generation/domain/step-intent";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";
import type { CodexTokenUsage } from "@kernel/telemetry/genai-semconv";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { traceHarness } from "./trace-harness";

const INTENT: StepIntentContext = { specTargets: { kind: "dir", relDir: "e2e" }, authFiles: [], loginUrls: [], authOnlyOrigins: [], reviewAgents: [] };
const USAGE: CodexTokenUsage = { inputTokens: 12_000, cachedInputTokens: 9_000, outputTokens: 40, reasoningOutputTokens: 15 };
const attr = (span: ReadableSpan, key: string): unknown => span.attributes[key];

interface Rig {
  deps: AgentDeps;
  h: ReturnType<typeof traceHarness>;
  traces: AgentTurnTraces;
  events: AgentTurnEvent[];
  sent: string[];
}

function rig(transportPrompt: (text: string, opts: CodexTransportPromptOpts | undefined) => Promise<string>, over: { telemetry?: TelemetryPort; onAttempt?: (sessionId: string, event: never) => void } = {}): Rig {
  resetCodexCircuit();
  const h = traceHarness();
  const traces = new AgentTurnTraces();
  const sent: string[] = [];
  const events: AgentTurnEvent[] = [];
  const transport: CodexHeadlessTransport = {
    start: async () => ({
      id: "codex-session",
      prompt: async (text, opts) => {
        sent.push(text);
        return transportPrompt(text, opts);
      },
      dispose: async () => {},
    }),
    health: async () => ({ provider: "codex", status: "healthy", configured: true }),
    listModels: async () => [],
  };
  const strategy = new CodexRuntimeStrategy({
    env: { CODEX_API_KEY: "k" },
    transport,
    promptRoot: "/nonexistent-prompt-root",
    onAttempt: (sessionId, event) => (over.onAttempt ?? ((id: string, e: Parameters<AgentTurnTraces["attempt"]>[1]) => traces.attempt(id, e)))(sessionId, event as never),
    outerLimit: (sessionId, prompt) => traces.firedBy(sessionId, prompt),
    attemptSpan: (sessionId) => traces.attemptSpan(sessionId),
  });
  const base: AgentDeps = { open: async (agent, cwd, opts) => strategy.openSession(roleForLegacyAgent(agent), cwd, { ...opts, onTurn: (t) => events.push(t) }) };
  const deps = withTurnTelemetry(base, { telemetry: over.telemetry ?? h.telemetry, clock: h.clock, intent: INTENT, traces });
  return { deps, h, traces, events, sent };
}

async function turn(r: Rig, opts: { model?: string } = {}): Promise<{ output?: string; error?: unknown }> {
  const session = await r.deps.open("qa-generator", "/repo", { descriptor: { runId: "run-1", role: "qa-generator" }, ...(opts.model ? { model: opts.model } : {}) });
  try {
    return { output: await session.prompt("write the spec", { sectionHashes: { task: "h-task" } }) };
  } catch (error) {
    return { error };
  } finally {
    await session.dispose();
  }
}

test("a Codex prompt is an invoke_agent span with one attempt, and the tokens Codex reported are on both, input counted with the cache", async () => {
  const r = rig(async (_text, opts) => {
    opts?.onUsage?.(USAGE);
    return "done";
  });
  const out = await turn(r, { model: "any-model" });
  assert.equal(out.output, "done");
  const root = r.h.only("invoke_agent qa-generator");
  const attempt = r.h.only("qayaba.agent.attempt");
  assert.equal(attempt.parentSpanContext?.spanId, root.spanContext().spanId);
  for (const span of [root, attempt]) {
    assert.equal(attr(span, "qayaba.usage.input_tokens"), 12_000, span.name);
    assert.equal(attr(span, "qayaba.usage.cache_read_tokens"), 9_000, span.name);
    assert.equal(attr(span, "qayaba.usage.output_tokens"), 40, span.name);
    assert.equal(attr(span, "qayaba.usage.reasoning_tokens"), 15, span.name);
    assert.equal(attr(span, "qayaba.usage.source"), "final-message", span.name);
  }
  assert.equal(attr(root, "qayaba.usage.cost"), undefined, "Codex reports no cost and none is invented");
  assert.equal(attr(attempt, "gen_ai.request.model"), "any-model");
  assert.deepEqual(r.h.unended(), []);
});

test("the turn Codex's prompt records carries the tokens in the shape every runtime's row has, and the hash of the bytes that were sent", async () => {
  const r = rig(async (_text, opts) => {
    opts?.onUsage?.(USAGE);
    return "done";
  });
  await turn(r);
  const event = r.events[0]!;
  assert.equal(event.tokensInput, 3_000, "input without the cache, as every row holds it");
  assert.equal(event.tokensCacheRead, 9_000);
  assert.equal(event.tokensOutput, 40);
  assert.equal(event.tokensReasoning, 15);
  assert.equal(event.cost, null);
  assert.equal(event.promptHash, createHash("sha256").update(r.sent[0]!).digest("hex"));
  assert.equal(event.ended, "completed");
});

test("a prompt Codex reported nothing for says so: no tokens, source none", async () => {
  const r = rig(async () => "done");
  await turn(r);
  const root = r.h.only("invoke_agent qa-generator");
  assert.equal(attr(root, "qayaba.usage.source"), "none");
  assert.equal(attr(root, "qayaba.usage.input_tokens"), undefined);
  assert.equal(r.events[0]!.tokensInput, null);
});

test("a failed Codex prompt ends its attempt and its turn with the class of the failure", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["a rate limit", codexErrorToInfra(new Error("codex exec exited 1: 429 too many requests")), "rate_limited"],
    ["an exhausted quota", codexErrorToInfra(new Error("codex exec exited 1: insufficient_quota, check your billing")), "quota_exceeded"],
    ["a rejected key", codexErrorToInfra(new Error("codex exec exited 1: 401 unauthorized")), "auth"],
    ["a deadline the transport fired", codexErrorToInfra(new Error("codex prompt: timed out after 5000ms")) ?? new AgentTimeoutError("Codex prompt: timed out after 5000ms"), "timeout"],
    ["an abort", codexErrorToInfra(new Error("codex exec exited 143: aborted by sigterm")), "aborted"],
    ["a failure nothing recognises", new Error("codex exec exited 2: segfault"), "unknown"],
  ];
  for (const [label, error, expected] of cases) {
    const r = rig(async () => {
      throw error;
    });
    const out = await turn(r);
    assert.equal(out.error, error, label);
    assert.equal(attr(r.h.only("qayaba.agent.attempt"), "error.type"), expected, `${label}: attempt`);
    assert.equal(attr(r.h.only("invoke_agent qa-generator"), "error.type"), expected, `${label}: turn`);
    assert.deepEqual(r.h.unended(), [], label);
  }
});

test("an infra failure of the transport is the same error object the caller got, tagged but not replaced", async () => {
  const error = new AgentUnavailableError("Codex provider rejected the request", { cause: new Error("429 too many requests") });
  const r = rig(async () => {
    throw error;
  });
  const out = await turn(r);
  assert.equal(out.error, error);
});

test("a telemetry port that throws changes nothing the caller sees of a Codex prompt", async () => {
  const run = async (telemetry: TelemetryPort | undefined) => {
    const r = rig(async (_text, opts) => {
      opts?.onUsage?.(USAGE);
      return "done";
    }, telemetry ? { telemetry } : {});
    const out = await turn(r);
    const { ts: _ts, ...event } = r.events[0]!;
    return { out, event: { ...event, durationMs: 0 } };
  };
  assert.deepEqual(await run(new ThrowingTelemetry()), await run(undefined));
});

test("a trace that fails while it is told about the prompt never reaches the prompt", async () => {
  const r = rig(async () => "done", {
    onAttempt: () => {
      throw new Error("trace exploded");
    },
  });
  const out = await turn(r);
  assert.equal(out.output, "done");
  assert.equal(r.events.length, 1);
});

test("classifyCodexFault reads the failure the exec reported, not the words of the wrapper that carries it", () => {
  assert.equal(classifyCodexFault(codexErrorToInfra(new Error("codex exec exited 1: 429 rate limit reached"))), "rate_limited");
  assert.equal(classifyCodexFault(codexErrorToInfra(new Error("codex exec exited 1: 402 payment required"))), "quota_exceeded");
  assert.equal(classifyCodexFault(codexErrorToInfra(new Error("codex exec exited 1: 403 forbidden"))), "auth");
  assert.equal(classifyCodexFault("not an error"), "unknown");
});

test("the transport is handed the traceparent of the attempt span, so Codex's own spans can hang under it", async () => {
  const seen: Array<string | undefined> = [];
  const r = rig(async (_text, opts) => {
    seen.push(opts?.traceparent);
    return "done";
  });
  await turn(r);
  const attempt = r.h.only("qayaba.agent.attempt");
  assert.equal(seen[0], `00-${attempt.spanContext().traceId}-${attempt.spanContext().spanId}-01`);
});

test("a prompt with no attempt span, because nothing is traced, hands the transport no traceparent", async () => {
  const seen: Array<string | undefined> = [];
  const r = rig(async (_text, opts) => {
    seen.push(opts?.traceparent);
    return "done";
  }, { telemetry: new NoopTelemetry() });
  await turn(r);
  assert.deepEqual(seen, [undefined]);
});
