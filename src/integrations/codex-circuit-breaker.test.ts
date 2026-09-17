/* Unit tests for the Codex circuit breaker. Mirrors the OpenCode breaker tests but for the
   Codex-specific breaker. All state is process-global in codex-circuit-breaker.ts; tests reset
   between runs.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkCodexCircuit,
  recordCodexCircuitFailure,
  recordCodexCircuitSuccess,
  resetCodexCircuit,
} from "./codex-circuit-breaker";

function setup() {
  resetCodexCircuit();
}

describe("codex circuit breaker state machine (T-P2-6 / AC2.6.1)", () => {
  test("checkCodexCircuit does NOT throw when circuit is closed (healthy baseline)", () => {
    setup();
    assert.doesNotThrow(() => checkCodexCircuit(), "circuit must not throw when closed");
  });

  test("circuit opens after CIRCUIT_THRESHOLD (5) consecutive failures", () => {
    setup();
    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure();
    }
    assert.throws(
      () => checkCodexCircuit(),
      /Codex circuit breaker is OPEN/i,
      "circuit must throw after 5 consecutive failures",
    );
  });

  test("circuit does NOT open after fewer than THRESHOLD failures (AC2.6.1)", () => {
    setup();
    /* Record 4 failures (threshold is 5) — must not open */
    for (let i = 0; i < 4; i++) {
      recordCodexCircuitFailure();
    }
    assert.doesNotThrow(() => checkCodexCircuit(), "circuit must not open on fewer than 5 failures");
  });

  test("open circuit rejects further calls with cooldown message (AC2.6.1)", () => {
    setup();
    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure();
    }
    /* Check multiple times — each must throw */
    assert.throws(() => checkCodexCircuit(), /Codex circuit breaker is OPEN/i);
    assert.throws(() => checkCodexCircuit(), /Codex circuit breaker is OPEN/i);
  });

  test("recordCodexCircuitSuccess resets failure count (circuit stays closed after mixed signals)", () => {
    setup();
    recordCodexCircuitFailure();
    recordCodexCircuitFailure();
    recordCodexCircuitFailure();
    recordCodexCircuitSuccess();
    /* Now 2 more failures (total 2 from reset, below threshold) — must not open */
    recordCodexCircuitFailure();
    recordCodexCircuitFailure();
    assert.doesNotThrow(() => checkCodexCircuit(), "circuit must not open after success resets the counter");
  });

  test("resetCodexCircuit closes an open circuit immediately (operator recovery action)", () => {
    setup();
    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure();
    }
    assert.throws(() => checkCodexCircuit(), /Codex circuit breaker is OPEN/i);

    resetCodexCircuit();

    /* Must not throw now */
    assert.doesNotThrow(() => checkCodexCircuit(), "circuit must be closed after resetCodexCircuit()");
  });

  test("codex and opencode breakers are independent — codex open does not affect opencode (isolation)", async () => {
    setup();
    const { checkCircuit, resetCircuit } = await import(
      "@contexts/generation/infrastructure/resilience/circuit-breaker"
    );

    resetCodexCircuit();
    resetCircuit();

    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure();
    }

    /* Codex must be open */
    assert.throws(() => checkCodexCircuit(), /Codex circuit breaker is OPEN/i);

    /* OpenCode breaker must NOT be open (separate state) */
    assert.doesNotThrow(() => checkCircuit(), "opencode circuit must remain closed when codex trips");

    resetCodexCircuit();
    resetCircuit();
  });
});

/* The strategy's openSession.prompt path must call checkCodexCircuit so an open Codex breaker
   short-circuits without spawning a new exec.
 */

import {
  CodexRuntimeStrategy,
  type CodexHeadlessTransport,
  type CodexTransportSession,
  type CodexTransportStartInput,
} from "../agent-runtime/codex-strategy";
import type { AgentModelInfo, AgentProviderHealth } from "../agent-runtime/types";

describe("CodexRuntimeStrategy circuit breaker wiring (T-P2-6 / AC2.6.1)", () => {
  test("open codex circuit rejects prompt without calling the transport (AC2.6.1)", async () => {
    resetCodexCircuit();

    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure();
    }

    let transportCalled = false;
    const stubbedTransport: CodexHeadlessTransport = {
      async start(_input: CodexTransportStartInput): Promise<CodexTransportSession> {
        return {
          id: "stub-id",
          prompt: async (_text: string) => {
            transportCalled = true;
            return "should not be reached";
          },
          dispose: async () => {},
        };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [{ id: "gpt-5.4", label: "GPT-5.4" }];
      },
    };

    const strategy = new CodexRuntimeStrategy({
      transport: stubbedTransport,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("primary", "/tmp", {});

    let caughtErr: unknown;
    try {
      await session.prompt("run tests");
    } catch (err) {
      caughtErr = err;
    }

    /* The circuit breaker must have prevented the transport from being called. */
    assert.ok(
      !transportCalled,
      "transport.prompt must NOT be called when the codex circuit is open",
    );
    /* The error must mention the circuit breaker. */
    assert.ok(caughtErr instanceof Error, "Must throw an Error when circuit is open");
    assert.match(
      (caughtErr as Error).message,
      /Codex circuit breaker is OPEN/i,
      "Error message must indicate the codex circuit is open",
    );

    resetCodexCircuit();
  });
});
