/* Unit tests for the Codex circuit breaker. Mirrors the OpenCode breaker tests but for the
   Codex-specific breaker. State is keyed per agent role (J1 — mirrors
   qa-engine/.../resilience/circuit-breaker.ts); resetCodexCircuit() with no argument resets
   every role's state at once.
 */

import { test, describe } from "node:test";
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

describe("codex circuit breaker state machine", () => {
  test("checkCodexCircuit does NOT throw when circuit is closed (healthy baseline)", () => {
    setup();
    assert.doesNotThrow(() => checkCodexCircuit("primary"), "circuit must not throw when closed");
  });

  test("circuit opens after CIRCUIT_THRESHOLD (5) consecutive failures", () => {
    setup();
    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure("primary");
    }
    assert.throws(
      () => checkCodexCircuit("primary"),
      /Codex circuit breaker is OPEN/i,
      "circuit must throw after 5 consecutive failures",
    );
  });

  test("circuit does NOT open after fewer than THRESHOLD failures", () => {
    setup();
    /* Record 4 failures (threshold is 5) — must not open */
    for (let i = 0; i < 4; i++) {
      recordCodexCircuitFailure("primary");
    }
    assert.doesNotThrow(() => checkCodexCircuit("primary"), "circuit must not open on fewer than 5 failures");
  });

  test("open circuit rejects further calls with cooldown message", () => {
    setup();
    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure("primary");
    }
    /* Check multiple times — each must throw */
    assert.throws(() => checkCodexCircuit("primary"), /Codex circuit breaker is OPEN/i);
    assert.throws(() => checkCodexCircuit("primary"), /Codex circuit breaker is OPEN/i);
  });

  test("recordCodexCircuitSuccess resets failure count (circuit stays closed after mixed signals)", () => {
    setup();
    recordCodexCircuitFailure("primary");
    recordCodexCircuitFailure("primary");
    recordCodexCircuitFailure("primary");
    recordCodexCircuitSuccess("primary");
    /* Now 2 more failures (total 2 from reset, below threshold) — must not open */
    recordCodexCircuitFailure("primary");
    recordCodexCircuitFailure("primary");
    assert.doesNotThrow(() => checkCodexCircuit("primary"), "circuit must not open after success resets the counter");
  });

  test("resetCodexCircuit() with no argument closes an open circuit immediately for every role (operator recovery action)", () => {
    setup();
    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure("primary");
    }
    assert.throws(() => checkCodexCircuit("primary"), /Codex circuit breaker is OPEN/i);

    resetCodexCircuit();

    /* Must not throw now */
    assert.doesNotThrow(() => checkCodexCircuit("primary"), "circuit must be closed after resetCodexCircuit()");
  });

  /* J1: codex-circuit-breaker.ts used to be a single set of module-level counters shared by
     every agent role on the Codex runtime — a run-away reviewer would trip the SAME breaker a
     healthy primary relies on. State must be keyed per role, mirroring the OpenCode breaker. */
  test("tripping one role's circuit does not block a different role", () => {
    setup();
    for (let i = 0; i < 5; i++) recordCodexCircuitFailure("reviewer");
    assert.throws(() => checkCodexCircuit("reviewer"), /Codex circuit breaker is OPEN/i);
    assert.doesNotThrow(() => checkCodexCircuit("primary"), "an unrelated role's circuit must stay closed");
    resetCodexCircuit();
  });

  test("a success on one role does not reset a different role's failure streak", () => {
    setup();
    recordCodexCircuitFailure("primary");
    recordCodexCircuitFailure("primary");
    recordCodexCircuitFailure("primary");
    recordCodexCircuitFailure("primary");
    recordCodexCircuitSuccess("reviewer"); /* an unrelated role's success */
    recordCodexCircuitFailure("primary"); /* primary's 5th consecutive failure */
    assert.throws(
      () => checkCodexCircuit("primary"),
      /Codex circuit breaker is OPEN/i,
      "reviewer's success must not have reset primary's own failure streak",
    );
    resetCodexCircuit();
  });

  test("codex and opencode breakers are independent — codex open does not affect opencode (isolation)", async () => {
    setup();
    const { checkCircuit, resetCircuit } = await import(
      "@contexts/generation/infrastructure/resilience/circuit-breaker"
    );

    resetCodexCircuit();
    resetCircuit();

    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure("primary");
    }

    /* Codex must be open */
    assert.throws(() => checkCodexCircuit("primary"), /Codex circuit breaker is OPEN/i);

    /* OpenCode breaker must NOT be open (separate state, separate module). */
    assert.doesNotThrow(() => checkCircuit("qa-generator"), "opencode circuit must remain closed when codex trips");

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

describe("CodexRuntimeStrategy circuit breaker wiring", () => {
  test("open codex circuit rejects prompt without calling the transport", async () => {
    resetCodexCircuit();

    for (let i = 0; i < 5; i++) {
      recordCodexCircuitFailure("primary");
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
