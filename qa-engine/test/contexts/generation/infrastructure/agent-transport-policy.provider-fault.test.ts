/* A provider fault the runtime only retries (a spent quota) ends the prompt in flight at once, classified, instead of waiting out the turn's deadline. A transient retry (rate limiting) is left to the runtime. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentUnavailableError } from "@kernel/domain-error.ts";
import { createAgentDeps, notifySessionRetry, type AttemptEvent, type RawAgentTransport, type RawPromptResult } from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";
import { carriedAgentErrorType } from "@contexts/generation/domain/agent-error-class.ts";
import { setRawEventStreamOpener, startScopedEventStream } from "@contexts/generation/infrastructure/sse/event-stream.ts";

const SESSION = "sess-fault";

function hangingTransport(aborted: string[]): { raw: RawAgentTransport; answer: (r: RawPromptResult) => void } {
  let answer: (r: RawPromptResult) => void = () => {};
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: SESSION }),
    promptSession: () => new Promise<RawPromptResult>((resolve) => { answer = resolve; }),
    abortSession: async (id) => { aborted.push(id); },
    deleteSession: async () => {},
  };
  return { raw, answer: (r) => answer(r) };
}

async function openPrompt(raw: RawAgentTransport, events: AttemptEvent[] = []) {
  resetCircuit();
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 60_000, getFallbackModel: () => undefined, onAttempt: (_id, e) => events.push(e) });
  const session = await deps.open("qa-reviewer", "/w");
  const inFlight = session.prompt("explore");
  /* Let the attempt reach the transport before the runtime reports on it. */
  await new Promise((r) => setImmediate(r));
  return { inFlight };
}

test("a quota retry reported for the session ends its prompt at once as an infra error classified quota_exceeded, and aborts the session", async () => {
  const aborted: string[] = [];
  const events: AttemptEvent[] = [];
  const { inFlight } = await openPrompt(hangingTransport(aborted).raw, events);

  notifySessionRetry(SESSION, "Go usage limit exceeded");

  const err = await inFlight.then(() => assert.fail("the prompt must not resolve"), (e: unknown) => e);
  assert.ok(err instanceof AgentUnavailableError, `expected AgentUnavailableError, got ${String(err)}`);
  assert.match(err.message, /Go usage limit exceeded/);
  assert.equal(carriedAgentErrorType(err), "quota_exceeded");
  assert.ok(aborted.includes(SESSION));
  const end = events.find((e) => e.kind === "end");
  assert.ok(end && end.kind === "end");
  assert.equal(end.errorType, "quota_exceeded");
});

test("a rate-limit retry leaves the prompt to the runtime: it still resolves with the answer", async () => {
  const aborted: string[] = [];
  const t = hangingTransport(aborted);
  const { inFlight } = await openPrompt(t.raw);

  notifySessionRetry(SESSION, "Rate limit exceeded, retrying in 2s");
  t.answer({ parts: [{ type: "text", text: "brief" }] });

  assert.equal(await inFlight, "brief");
  assert.deepEqual(aborted, []);
});

test("a session.status retry on the event stream reaches the prompt in flight", async () => {
  const { inFlight } = await openPrompt(hangingTransport([]).raw);
  const restore = setRawEventStreamOpener({
    open: async () => (async function* () {
      yield { type: "session.status", properties: { sessionID: SESSION, status: { type: "retry", attempt: 1, message: "Go usage limit exceeded", next: Date.now() + 3_600_000 } } };
    })(),
  });
  try {
    await startScopedEventStream("/w", () => {});
  } finally {
    restore();
  }

  const err = await inFlight.then(() => assert.fail("the prompt must not resolve"), (e: unknown) => e);
  assert.equal(carriedAgentErrorType(err), "quota_exceeded");
});
