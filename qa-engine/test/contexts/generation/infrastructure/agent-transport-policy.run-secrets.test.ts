/* The transport is the last seam before a prompt reaches a model: whatever text got there without passing the text sanitizer still has the run's own secrets taken out by value, and the turn recorded for the prompt never holds them either. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { createAgentDeps, type AgentTurnEvent, type RawAgentTransport } from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";

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
    const session = await deps.open("qa-generator", "/tmp", { onTurn: (turn: AgentTurnEvent) => void turns.push(turn) });
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
  const session = await deps.open("qa-generator", "/tmp");
  await session.prompt(`the DOM said ${PASSWORD}`);
  await session.dispose();
  assert.deepEqual(seen, [`the DOM said ${PASSWORD}`]);
});
