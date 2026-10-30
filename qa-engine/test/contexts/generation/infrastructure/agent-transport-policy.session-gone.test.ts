/* A prompt to a session the runtime no longer has ends at once as that fault: no other model can answer in a session that is not there, so no fallback attempt is made, and the fault keeps its type for the holder that decides whether to start a fresh session. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionGoneError, isSessionGoneError } from "@kernel/turn-end.ts";
import { createAgentDeps, type AttemptEvent, type RawAgentTransport } from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";

test("a session the runtime no longer has ends the prompt as session_gone, with no fallback attempt", async () => {
  resetCircuit();
  const prompted: unknown[] = [];
  const events: AttemptEvent[] = [];
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: "sess-gone" }),
    promptSession: async ({ model }) => {
      prompted.push(model);
      throw new SessionGoneError("OpenCode session.prompt: session sess-gone not found");
    },
    abortSession: async () => {},
    deleteSession: async () => {},
  };
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 60_000, getFallbackModel: () => "fallback/model", onAttempt: (_id, e) => events.push(e) });
  const session = await deps.open("qa-author", "/w");

  const err = await session.prompt("write").then(() => assert.fail("the prompt must not resolve"), (e: unknown) => e);

  assert.ok(isSessionGoneError(err), `expected a session-gone fault, got ${String(err)}`);
  assert.deepEqual(prompted, [undefined]);
  const turn = events.find((e) => e.kind === "turn");
  assert.ok(turn && turn.kind === "turn");
  assert.equal(turn.turn.ended, "failed");
  assert.equal(turn.turn.errorType, "session_gone");
});
