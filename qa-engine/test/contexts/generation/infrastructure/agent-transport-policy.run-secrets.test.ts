/* The transport is the last seam before a prompt reaches a model: whatever text got there without passing the text sanitizer still has the run's own secrets taken out by value, and the turn recorded for the prompt never holds them either. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { createAgentDeps, type AgentTurnEvent, type RawAgentTransport } from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-kernel/run-secret-redaction.ts";

const PASSWORD = "plain-pass-9981";

function transport(seen: string[]): RawAgentTransport {
  return {
    createSession: async () => ({ id: "sess-1" }),
    promptSession: async (args) => {
      seen.push(args.text);
      return { parts: [{ type: "text", text: "ok" }] };
    },
    abortSession: async () => {},
    deleteSession: async () => {},
  };
}

test("a prompt sent inside a run reaches the model, and is recorded, without the run's secrets", async () => {
  resetCircuit();
  const seen: string[] = [];
  const turns: AgentTurnEvent[] = [];
  const scope = createRunSecretScope();
  scope.addAccountSecrets([PASSWORD]);
  const deps = createAgentDeps(transport(seen), { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

  await withRunSecretScope(scope, async () => {
    const session = await deps.open("qa-author", "/tmp", { onTurn: (turn: AgentTurnEvent) => void turns.push(turn) });
    await session.prompt(`the DOM said ${PASSWORD}`);
    await session.dispose();
  });

  assert.deepEqual(seen, [`the DOM said ${REDACTED}`]);
  assert.equal(turns.length, 1);
  assert.ok(turns.every((turn) => !turn.promptText.includes(PASSWORD)));
});

test("a prompt sent outside a run is sent as it is", async () => {
  resetCircuit();
  const seen: string[] = [];
  const deps = createAgentDeps(transport(seen), { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });
  const session = await deps.open("qa-author", "/tmp");
  await session.prompt(`the DOM said ${PASSWORD}`);
  await session.dispose();
  assert.deepEqual(seen, [`the DOM said ${PASSWORD}`]);
});

/* ── what a turn that did not answer had streamed ── */

const STREAMED = { totalCalls: 3, stepsUsed: 2, observationComplete: true, callsBeforeFirstWrite: 3, writeCount: 0, commandCount: 0, redundantReadCount: 0, sameFileReadCount: 0, duplicateCallCount: 0, promptProvidedReadCount: 0, pathProvidedReadCount: 0, graphProvidedReadCount: 0, buckets: { code_read: 3, code_graph: 0, browser: 0, write: 0, validate_run: 0, script_run: 0, memory: 0, subagent: 0, other: 0 }, timeToFirstCallMs: null, timeToFirstWriteMs: null, deniedCallCount: 0, toolSequence: [], usage: null };

test("a turn that timed out records what it had streamed so far, without the run's secrets", async () => {
  resetCircuit();
  const turns: AgentTurnEvent[] = [];
  const scope = createRunSecretScope();
  scope.addAccountSecrets([PASSWORD]);
  const hung: RawAgentTransport = { ...transport([]), promptSession: () => new Promise(() => {}) };
  const deps = createAgentDeps(hung, {
    defaultPromptTimeoutMs: 15,
    getFallbackModel: () => undefined,
    takeTurnCalls: () => ({ ...STREAMED, streamedText: `[reasoning] the login takes ${PASSWORD}\n[text] Writing the spec` }),
  });

  await withRunSecretScope(scope, async () => {
    const session = await deps.open("qa-author", "/tmp", { onTurn: (turn: AgentTurnEvent) => void turns.push(turn) });
    await assert.rejects(() => session.prompt("write the specs"), /timed out/);
  });

  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.ended, "timeout");
  assert.equal(turns[0]!.outputText, "");
  assert.equal(turns[0]!.partialText, `[reasoning] the login takes ${REDACTED}\n[text] Writing the spec`);
});

test("a turn that timed out having streamed nothing records no partial text", async () => {
  resetCircuit();
  const turns: AgentTurnEvent[] = [];
  const hung: RawAgentTransport = { ...transport([]), promptSession: () => new Promise(() => {}) };
  const deps = createAgentDeps(hung, { defaultPromptTimeoutMs: 15, getFallbackModel: () => undefined, takeTurnCalls: () => STREAMED });
  const session = await deps.open("qa-author", "/tmp", { onTurn: (turn: AgentTurnEvent) => void turns.push(turn) });
  await assert.rejects(() => session.prompt("write the specs"), /timed out/);
  assert.equal(turns[0]!.partialText, null);
});

test("an answered turn records no partial text: its answer is the output", async () => {
  resetCircuit();
  const turns: AgentTurnEvent[] = [];
  const deps = createAgentDeps(transport([]), {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => undefined,
    takeTurnCalls: () => ({ ...STREAMED, streamedText: "[text] ok" }),
  });
  const session = await deps.open("qa-author", "/tmp", { onTurn: (turn: AgentTurnEvent) => void turns.push(turn) });
  await session.prompt("write the specs");
  assert.equal(turns[0]!.ended, "completed");
  assert.equal(turns[0]!.partialText, null);
});
