/* qa-engine/test/contexts/generation/infrastructure/agent-transport-policy.test.ts
   Moved from src/integrations/{stall-watchdog-wrapper,session-registration-wrapper,opencode-client}
   POLICY (circuit-breaker gating, fallback retry, stall-watchdog decoration, session registration,
   turn/usage telemetry) that now lives in agent-transport-policy.ts, decoupled from the SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StalledAgentError, isInfraError } from "@kernel/domain-error.ts";
import {
  withStallWatchdog,
  withSessionRegistration,
  notifySessionActivity,
  parseModelRef,
  withTimeout,
  agentErrorToInfra,
  createAgentDeps,
  type AgentDeps,
  type RawAgentTransport,
  type AgentTurnEvent,
} from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { createStallWatchdog } from "@contexts/generation/infrastructure/resilience/stall-watchdog.ts";
import { CIRCUIT_THRESHOLD, recordCircuitFailure, resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";

/* Build a minimal fake AgentDeps whose prompt() resolves after a delay we control. */
function makeDelayDeps(opts: {
  rejectWith?: unknown;
  sessionId?: string;
}): { deps: AgentDeps } {
  const deps: AgentDeps = {
    open: async (_agent, _cwd, _openOpts) => {
      return {
        id: opts.sessionId ?? "test-session",
        prompt: async (_text) => {
          if (opts.rejectWith !== undefined) throw opts.rejectWith;
          return '{"approved":true,"specs":[]}';
        },
        dispose: async () => {},
      };
    },
  };
  return { deps };
}

test("withStallWatchdog wraps AgentDeps and returns a valid AgentDeps", async () => {
  const { deps: base } = makeDelayDeps({});
  const wrapped = withStallWatchdog(base, { stallMs: 5000 });

  assert.equal(typeof wrapped.open, "function");

  const session = await wrapped.open("qa-generator", "/tmp");
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.dispose, "function");
  await session.dispose();
});

test("withStallWatchdog: prompt() succeeds normally when no stall occurs", async () => {
  const { deps: base } = makeDelayDeps({});
  const wrapped = withStallWatchdog(base, { stallMs: 5000 });

  const session = await wrapped.open("qa-generator", "/tmp");
  const result = await session.prompt("hello");
  assert.equal(result, '{"approved":true,"specs":[]}');
  await session.dispose();
});

test("withStallWatchdog: stall triggers StalledAgentError rejection via injected watchdog", async () => {
  let stallCb: (() => void) | undefined;

  const fakeWatchdogFactory = (onStall: () => void) => {
    stallCb = onStall;
    return createStallWatchdog({
      stallMs: 99999,
      onStall,
    });
  };

  /* A base deps whose prompt() never resolves (simulates a hung agent) */
  let resolvePrompt!: (v: string) => void;
  const base: AgentDeps = {
    open: async () => ({
      id: "hung-session",
      prompt: (_text) => new Promise<string>((res) => { resolvePrompt = res; }),
      dispose: async () => {},
    }),
  };

  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: fakeWatchdogFactory,
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  const promptPromise = session.prompt("hello");

  assert.ok(stallCb !== undefined, "stall callback must be registered during open()");
  (stallCb as () => void)();

  await assert.rejects(
    () => promptPromise,
    (err: unknown) => {
      assert.ok(err instanceof StalledAgentError, `expected StalledAgentError, got ${(err as Error)?.name}`);
      return true;
    },
    "prompt() must reject with StalledAgentError when the watchdog fires",
  );

  await session.dispose();
  void resolvePrompt;
});

test("withStallWatchdog: stall path unregisters the session notifier (no registry leak)", async () => {
  let notifyCount = 0;
  let stallCb: (() => void) | undefined;
  const fakeWatchdog = { notify: () => { notifyCount++; }, stop: () => {} };

  const base: AgentDeps = {
    open: async () => ({
      id: "leak-test-session",
      prompt: () => new Promise<string>(() => {}), /* never resolves (hung agent) */
      dispose: async () => {},
    }),
  };

  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: (onStall) => { stallCb = onStall; return fakeWatchdog; },
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  const promptPromise = session.prompt("hello").catch(() => {}); /* swallow the stall rejection */

  notifySessionActivity("leak-test-session");
  const beforeStall = notifyCount;
  assert.ok(beforeStall >= 1, "the session notifier must be registered and invoked on activity");

  /* Stall fires → the stall path must unregister the notifier. */
  assert.ok(stallCb !== undefined, "stall callback must be registered during open()");
  (stallCb as () => void)();
  await promptPromise;

  /* A further event must NOT reach the now-removed notifier. */
  notifySessionActivity("leak-test-session");
  assert.equal(notifyCount, beforeStall, "after a stall the session notifier must be unregistered (no registry leak)");

  await session.dispose();
});

test("withStallWatchdog: dispose() stops the watchdog (no leak after session ends)", async () => {
  let stopCalled = false;
  const fakeWatchdog = {
    notify: () => {},
    stop: () => { stopCalled = true; },
  };

  const base: AgentDeps = {
    open: async () => ({
      id: "dispose-test",
      prompt: async () => '{"approved":true,"specs":[]}',
      dispose: async () => {},
    }),
  };

  const wrapped = withStallWatchdog(base, {
    stallMs: 5000,
    watchdogFactory: (_onStall) => fakeWatchdog,
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  await session.dispose();

  assert.equal(stopCalled, true, "dispose() must stop the watchdog to prevent leaks");
});

test("withStallWatchdog: a self-timed session (Codex exec) skips the watchdog entirely", async () => {
  let watchdogCreated = false;
  const base: AgentDeps = {
    open: async () => ({
      id: "codex-session",
      prompt: async () => "codex result",
      dispose: async () => {},
      selfTimed: true,
    }),
  };
  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: () => { watchdogCreated = true; return { notify: () => {}, stop: () => {} }; },
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  assert.equal(watchdogCreated, false, "the watchdog must NOT be created for a self-timed session");
  assert.equal(session.selfTimed, true, "the self-timed marker is preserved on the returned session");
  assert.equal(await session.prompt("hello"), "codex result");
  await session.dispose();
});

test("withStallWatchdog: a normal (non-self-timed) session IS still wrapped", async () => {
  let watchdogCreated = false;
  const base: AgentDeps = {
    open: async () => ({ id: "opencode-session", prompt: async () => "ok", dispose: async () => {} }),
  };
  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: () => { watchdogCreated = true; return { notify: () => {}, stop: () => {} }; },
  });
  await wrapped.open("qa-generator", "/tmp");
  assert.equal(watchdogCreated, true, "a normal session must still be wrapped by the watchdog");
});

/* ─── withSessionRegistration ─────────────────────────────────────────────────────────────────────
   `collaborators` is REQUIRED: qa-engine cannot reach the shell registerRunSession/unregisterRunSession
   functions on its own, so the composition root (src/server/rewritten-engine-factory.ts) must inject
   them explicitly.
 */

function fakeBaseDeps(sessionId = "sess-1"): { deps: AgentDeps; disposed: boolean[] } {
  const disposed: boolean[] = [];
  const deps: AgentDeps = {
    open: async (_agent, _cwd, _opts) => ({
      id: sessionId,
      prompt: async (_text: string) => "output",
      dispose: async () => {
        disposed.push(true);
      },
    }),
  };
  return { deps, disposed };
}

test("withSessionRegistration returns a valid AgentDeps (structural)", async () => {
  const { deps: base } = fakeBaseDeps();
  const wrapped = withSessionRegistration(base, { register: () => {}, unregister: () => {} });
  assert.equal(typeof wrapped.open, "function");
  const session = await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-reviewer" },
  });
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.dispose, "function");
  await session.dispose();
});

test("withSessionRegistration calls register with the session id, descriptor.runId, and cwd when a runId is present", async () => {
  const { deps: base } = fakeBaseDeps("sess-99");
  const calls: Array<{ sessionId: string; runId: string; directory: string }> = [];
  const wrapped = withSessionRegistration(base, {
    register: (sessionId, runId, directory) => calls.push({ sessionId, runId, directory }),
    unregister: () => {},
  });

  await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-reviewer" },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: "sess-99", runId: "run-42", directory: "/mirrors/org/app" });
});

test("withSessionRegistration does NOT register when descriptor.runId is absent (no fabricated run identity)", async () => {
  const { deps: base } = fakeBaseDeps();
  let registerCalls = 0;
  const wrapped = withSessionRegistration(base, {
    register: () => { registerCalls++; },
    unregister: () => {},
  });

  await wrapped.open("qa-generator", "/mirrors/org/app");
  await wrapped.open("qa-generator", "/mirrors/org/app", { descriptor: { role: "qa-generator" } });

  assert.equal(registerCalls, 0, "no descriptor.runId means no run context — must not register a session under a fabricated identity");
});

test("withSessionRegistration does NOT register or unregister a session whose descriptor sets liveObservation false, even with a runId", async () => {
  const { deps: base } = fakeBaseDeps("sess-explorer");
  const registered: string[] = [];
  const unregistered: string[] = [];
  const wrapped = withSessionRegistration(base, {
    register: (sessionId) => registered.push(sessionId),
    unregister: (sessionId) => unregistered.push(sessionId),
  });

  const session = await wrapped.open("qa-explorer", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-explorer", liveObservation: false },
  });
  await session.dispose();

  assert.deepEqual(registered, [], "a liveObservation:false session must stay out of SSE/watchdog registration");
  assert.deepEqual(unregistered, []);
});

test("withSessionRegistration still registers when liveObservation is explicitly true", async () => {
  const { deps: base } = fakeBaseDeps("sess-live");
  const registered: string[] = [];
  const wrapped = withSessionRegistration(base, {
    register: (sessionId) => registered.push(sessionId),
    unregister: () => {},
  });

  await wrapped.open("qa-generator", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-generator", liveObservation: true },
  });

  assert.deepEqual(registered, ["sess-live"]);
});

test("withSessionRegistration unregisters the session on dispose", async () => {
  const { deps: base } = fakeBaseDeps("sess-77");
  const unregistered: string[] = [];
  const wrapped = withSessionRegistration(base, {
    register: () => {},
    unregister: (sessionId) => unregistered.push(sessionId),
  });

  const session = await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-1", role: "qa-reviewer" },
  });
  assert.equal(unregistered.length, 0, "must not unregister before dispose");
  await session.dispose();
  assert.deepEqual(unregistered, ["sess-77"]);
});

test("withSessionRegistration does NOT unregister on dispose when the session was never registered (no runId)", async () => {
  const { deps: base } = fakeBaseDeps("sess-55");
  let unregisterCalls = 0;
  const wrapped = withSessionRegistration(base, {
    register: () => {},
    unregister: () => { unregisterCalls++; },
  });

  const session = await wrapped.open("qa-generator", "/mirrors/org/app");
  await session.dispose();

  assert.equal(unregisterCalls, 0);
});

test("withSessionRegistration forwards prompt()/session identity unchanged (thin wrapper — no behavior mutation)", async () => {
  const { deps: base } = fakeBaseDeps("sess-passthrough");
  const wrapped = withSessionRegistration(base, { register: () => {}, unregister: () => {} });

  const session = await wrapped.open("qa-generator", "/mirrors/org/app");
  assert.equal(session.id, "sess-passthrough");
  const out = await session.prompt("hello");
  assert.equal(out, "output");
});

test("parseModelRef splits provider/model and rejects malformed refs", () => {
  /* The fallback model override must reach the SDK as {providerID, modelID}, not a raw string. A
     model id can itself contain slashes — only the FIRST splits.
   */
  assert.deepEqual(parseModelRef("opencode-go/deepseek-v4-pro"), { providerID: "opencode-go", modelID: "deepseek-v4-pro" });
  assert.deepEqual(parseModelRef("a/b/c"), { providerID: "a", modelID: "b/c" });
  /* Unparseable → undefined so the override is skipped, never sent malformed. */
  assert.equal(parseModelRef("noslash"), undefined);
  assert.equal(parseModelRef("/leading"), undefined);
  assert.equal(parseModelRef("trailing/"), undefined);
});

test("withTimeout resolves if the promise arrives in time", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, "x");
  assert.equal(v, "ok");
});

test("withTimeout rejects when the deadline elapses", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 50));
  await assert.rejects(() => withTimeout(slow, 5, "agent"), /timed out after 5ms/);
});

test("agentErrorToInfra classifies an embedded provider fault as infrastructure with an actionable message", () => {
  /* ROOT-CAUSE: a provider fault is embedded in res.data.info.error (NOT res.error). It must throw a
     typed InfraError so the run is `infra-error`, never a code verdict that blames the tests.
   */
  const auth = agentErrorToInfra({ name: "ProviderAuthError", data: { providerID: "opencode-go", message: "insufficient credits" } });
  assert.equal(isInfraError(auth), true);
  assert.match(auth.message, /out of credits|OPENCODE_API_KEY/i);
  assert.match(auth.message, /insufficient credits/);
  assert.match(auth.message, /not a test failure/i);

  const rate = agentErrorToInfra({ name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } });
  assert.equal(isInfraError(rate), true);
  assert.match(rate.message, /429|rate-limited/i);

  /* An unknown/future variant still classifies as infra, never a code verdict. */
  const unknown = agentErrorToInfra({ name: "UnknownError", data: { message: "boom" } });
  assert.equal(isInfraError(unknown), true);
  assert.match(unknown.message, /not a test failure/i);
});

/* createAgentDeps is the production transport policy — every generate/review/repair round funnels
   through it. Tests above exercise the decorator wrappers (withStallWatchdog/withSessionRegistration)
   against a hand-built fake AgentDeps; these characterize createAgentDeps(raw, collab) itself against
   a fake RawAgentTransport: fallback-model retry on a transient fault, skip-on-abort/infra-error,
   circuit-breaker gating, telemetry assembly, and sanitize-before-emit.
 */

function makeRawTransport(overrides: Partial<RawAgentTransport> = {}): RawAgentTransport {
  return {
    createSession: async (_cwd: string) => ({ id: "sess-default" }),
    promptSession: async () => ({ parts: [{ type: "text", text: "default output" }] }),
    abortSession: async () => {},
    deleteSession: async () => {},
    ...overrides,
  };
}

test("createAgentDeps: open()/prompt()/dispose() delegate to the raw transport and return its text", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-1" }),
    promptSession: async (args) => {
      assert.equal(args.agent, "qa-generator");
      assert.equal(args.text, "do the thing");
      return { parts: [{ type: "text", text: "hello world" }] };
    },
  });
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });
  const session = await deps.open("qa-generator", "/tmp");
  const out = await session.prompt("do the thing");
  assert.equal(out, "hello world");
  await session.dispose();
});

test("createAgentDeps: retries on the fallback model after a transient (non-infra) primary-model fault", async () => {
  resetCircuit();
  let attempt = 0;
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-2" }),
    promptSession: async (args) => {
      attempt++;
      if (attempt === 1) {
        assert.equal(args.model, undefined, "the primary attempt must not send a model override");
        throw new Error("ECONNRESET transient network fault");
      }
      assert.deepEqual(args.model, { providerID: "opencode-go", modelID: "fallback-model" }, "the retry must target the resolved fallback model");
      return { parts: [{ type: "text", text: "fallback succeeded" }] };
    },
  });
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: (agent) => (agent === "qa-generator" ? "opencode-go/fallback-model" : undefined),
  });
  const session = await deps.open("qa-generator", "/tmp");
  const out = await session.prompt("do the thing");
  assert.equal(out, "fallback succeeded");
  assert.equal(attempt, 2, "exactly one retry (primary + fallback) must have happened");
});

test("createAgentDeps: an aborted signal skips the fallback retry even when one is configured", async () => {
  resetCircuit();
  let attempts = 0;
  const controller = new AbortController();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-3" }),
    promptSession: async () => {
      attempts++;
      controller.abort(); /* the operator cancels while the request is in flight */
      throw new Error("operator cancel while in flight");
    },
  });
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => "opencode-go/should-never-be-used",
  });
  const session = await deps.open("qa-generator", "/tmp", { signal: controller.signal });
  await assert.rejects(() => session.prompt("do the thing"));
  assert.equal(attempts, 1, "an aborted signal must skip the fallback retry — a cancel must not be defeated by a retry");
});

test("createAgentDeps: an infra-class provider fault skips the fallback retry (same key, pointless to re-spend)", async () => {
  resetCircuit();
  let attempts = 0;
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-4" }),
    promptSession: async () => {
      attempts++;
      return {
        agentError: { name: "ProviderAuthError", data: { providerID: "opencode-go", message: "out of credits" } },
        parts: [],
      };
    },
  });
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => "opencode-go/should-never-be-used",
  });
  const session = await deps.open("qa-generator", "/tmp");
  await assert.rejects(
    () => session.prompt("do the thing"),
    (err: unknown) => isInfraError(err),
    "an embedded provider fault must surface as a typed InfraError",
  );
  assert.equal(attempts, 1, "an infra-class fault (out-of-credits/auth) must skip the fallback retry entirely");
});

test("createAgentDeps: circuit-breaker gating — an OPEN circuit rejects prompt() before the raw transport is ever called, and resetCircuit() restores normal operation", async () => {
  resetCircuit();
  try {
    let promptCalls = 0;
    const raw = makeRawTransport({
      createSession: async () => ({ id: "sess-5" }),
      promptSession: async () => {
        promptCalls++;
        return { parts: [{ type: "text", text: "ok" }] };
      },
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

    /* Force the circuit OPEN via the module's own threshold (5 consecutive recorded failures),
       keyed to the SAME role createAgentDeps derives internally (descriptor.role ?? agent — here
       just the bare "qa-generator" agent id, since no descriptor is passed below). */
    for (let i = 0; i < 5; i++) recordCircuitFailure("qa-generator");

    const openSession = await deps.open("qa-generator", "/tmp");
    /* NOTE: checkCircuit() rejects SYNCHRONOUSLY (it throws before any Promise is constructed), unlike
       every other failure path in createAgentDeps (which fails through an async raw.promptSession call
       and so settles as a genuine Promise rejection). node:assert's assert.rejects does NOT convert a
       synchronous throw from its callback into a caught rejection (verified: it re-throws uncaught) —
       only `await`/try-catch handles both cases uniformly. Every real production caller already awaits
       session.prompt() inside an async function or a `new Promise` executor, both of which DO normalize
       a synchronous throw into a rejection, so this is a test-authoring gotcha, not a production bug.
     */
    let openCircuitError: unknown;
    try {
      await openSession.prompt("do the thing");
    } catch (err) {
      openCircuitError = err;
    }
    assert.ok(openCircuitError instanceof Error, "the OPEN circuit must reject the prompt");
    assert.match((openCircuitError as Error).message, /circuit breaker is OPEN/);
    assert.equal(promptCalls, 0, "checkCircuit() must reject BEFORE the raw transport's promptSession is ever invoked");

    resetCircuit();
    const closedSession = await deps.open("qa-generator", "/tmp");
    const out = await closedSession.prompt("do the thing");
    assert.equal(out, "ok", "after resetCircuit() a normal prompt succeeds again");
    assert.equal(promptCalls, 1, "the raw transport is only reached once the circuit is closed");
  } finally {
    resetCircuit();
  }
});

/* createAgentDeps derives its circuit-breaker key from descriptor.role ?? agent — a run-away
   qa-reviewer (or any other role) must never trip the breaker for a healthy, unrelated qa-generator
   session, since both funnel through the SAME createAgentDeps/circuit-breaker module.
 */
test("createAgentDeps: an OPEN circuit for one agent role does not block a different role", async () => {
  resetCircuit();
  try {
    let generatorPromptCalls = 0;
    const raw = makeRawTransport({
      promptSession: async (args) => {
        if (args.agent === "qa-generator") generatorPromptCalls++;
        return { parts: [{ type: "text", text: "ok" }] };
      },
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

    /* Trip ONLY qa-reviewer's circuit. */
    for (let i = 0; i < 5; i++) recordCircuitFailure("qa-reviewer");

    const reviewerSession = await deps.open("qa-reviewer", "/tmp");
    let reviewerError: unknown;
    try {
      await reviewerSession.prompt("review this");
    } catch (err) {
      reviewerError = err;
    }
    assert.match((reviewerError as Error).message, /circuit breaker is OPEN/, "qa-reviewer's own circuit is open");

    const generatorSession = await deps.open("qa-generator", "/tmp");
    const out = await generatorSession.prompt("do the thing");
    assert.equal(out, "ok", "a DIFFERENT role's circuit must stay closed and reach the raw transport");
    assert.equal(generatorPromptCalls, 1);
  } finally {
    resetCircuit();
  }
});

/* Two breaker levels. The provider level is fed by every raw transport failure (the agent server
   itself is unreachable or erroring) whatever role hit it, and gates session creation and prompts
   for every role. The role level is fed by that role's prompt outcomes, including model/agent
   faults embedded in a successful response, and gates only that role's prompts. */
async function rejectionOf(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

test("createAgentDeps: session-creation failures spread across roles open the provider breaker for every role", async () => {
  resetCircuit();
  try {
    let createCalls = 0;
    const raw = makeRawTransport({
      createSession: async () => {
        createCalls++;
        throw new Error("connect ECONNREFUSED agents:4096");
      },
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      const err = await rejectionOf(() => deps.open(`role-${i}`, "/tmp"));
      assert.match(err?.message ?? "", /ECONNREFUSED/);
    }
    const callsBeforeFastFail = createCalls;
    const fastFail = await rejectionOf(() => deps.open("qa-generator", "/tmp"));
    assert.match(fastFail?.message ?? "", /circuit breaker is OPEN/);
    assert.equal(createCalls, callsBeforeFastFail, "an open provider breaker must not reach the transport");
  } finally {
    resetCircuit();
  }
});

test("createAgentDeps: prompt transport failures spread across roles fail every role's next prompt fast", async () => {
  resetCircuit();
  try {
    let promptCalls = 0;
    const raw = makeRawTransport({
      promptSession: async () => {
        promptCalls++;
        throw new Error("socket hang up");
      },
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      const session = await deps.open(`role-${i}`, "/tmp");
      await rejectionOf(() => session.prompt("do the thing"));
    }
    const callsBeforeFastFail = promptCalls;
    const fresh = await rejectionOf(async () => {
      const session = await deps.open("qa-reviewer", "/tmp");
      return session.prompt("review this");
    });
    assert.match(fresh?.message ?? "", /circuit breaker is OPEN/);
    assert.equal(promptCalls, callsBeforeFastFail, "no role may reach the transport while the provider breaker is open");
  } finally {
    resetCircuit();
  }
});

test("createAgentDeps: a session opened before the provider breaker trips fails its next prompt fast", async () => {
  resetCircuit();
  try {
    let reviewerPromptCalls = 0;
    const raw = makeRawTransport({
      promptSession: async (args) => {
        if (args.agent !== "qa-reviewer") throw new Error("socket hang up");
        reviewerPromptCalls++;
        return { parts: [{ type: "text", text: "ok" }] };
      },
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

    const reviewer = await deps.open("qa-reviewer", "/tmp");
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      const session = await deps.open(`role-${i}`, "/tmp");
      await rejectionOf(() => session.prompt("do the thing"));
    }

    const err = await rejectionOf(() => reviewer.prompt("review this"));
    assert.match(err?.message ?? "", /circuit breaker is OPEN/);
    assert.equal(reviewerPromptCalls, 0, "an already-open session must not reach the transport while the provider breaker is open");
  } finally {
    resetCircuit();
  }
});

test("createAgentDeps: an answered prompt resets the provider failure streak", async () => {
  resetCircuit();
  try {
    let serverDown = true;
    const raw = makeRawTransport({
      createSession: async () => {
        if (serverDown) throw new Error("connect ECONNREFUSED agents:4096");
        return { id: "sess-ok" };
      },
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

    for (let i = 0; i < CIRCUIT_THRESHOLD - 1; i++) await rejectionOf(() => deps.open(`role-${i}`, "/tmp"));
    serverDown = false;
    await (await deps.open("qa-generator", "/tmp")).prompt("do the thing");
    serverDown = true;
    for (let i = 0; i < CIRCUIT_THRESHOLD - 1; i++) await rejectionOf(() => deps.open(`role-${i}`, "/tmp"));
    serverDown = false;

    const session = await deps.open("qa-generator", "/tmp");
    assert.equal(session.id, "sess-ok", "the streak restarted after the answered prompt, so the breaker is still closed");
  } finally {
    resetCircuit();
  }
});

test("createAgentDeps: model faults embedded in a response trip only that role, never the provider breaker", async () => {
  resetCircuit();
  try {
    const raw = makeRawTransport({
      promptSession: async (args) =>
        args.agent === "qa-reviewer"
          ? { agentError: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } }, parts: [] }
          : { parts: [{ type: "text", text: "ok" }] },
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      const session = await deps.open("qa-reviewer", "/tmp");
      await rejectionOf(() => session.prompt("review this"));
    }
    const reviewer = await deps.open("qa-reviewer", "/tmp");
    assert.match((await rejectionOf(() => reviewer.prompt("review this")))?.message ?? "", /circuit breaker is OPEN/);

    const generator = await deps.open("qa-generator", "/tmp");
    assert.equal(await generator.prompt("do the thing"), "ok");
  } finally {
    resetCircuit();
  }
});

test("createAgentDeps: telemetry assembly — onTurn receives a fully-populated AgentTurnEvent for a run with a runId", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-6" }),
    promptSession: async () => ({
      parts: [{ type: "text", text: "assembled output" }],
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      cost: 0.0123,
    }),
  });
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });
  const turns: AgentTurnEvent[] = [];
  const session = await deps.open("qa-generator", "/tmp", {
    descriptor: { runId: "run-77", role: "qa-generator", objective: "write specs" },
    onTurn: (t) => turns.push(t),
  });
  const out = await session.prompt("do the thing", { round: 3, isRepair: true, sectionSizes: { diff: 1200 } });
  assert.equal(out, "assembled output");
  assert.equal(turns.length, 1);
  const t = turns[0]!;
  assert.equal(t.runId, "run-77");
  assert.equal(t.role, "qa-generator");
  assert.equal(t.objective, "write specs");
  assert.equal(t.round, 3);
  assert.equal(t.isRepair, true);
  assert.deepEqual(t.sectionSizes, { diff: 1200 });
  assert.equal(t.tokensInput, 100);
  assert.equal(t.tokensOutput, 50);
  assert.equal(t.tokensReasoning, 10);
  assert.equal(t.tokensCacheRead, 5);
  assert.equal(t.tokensCacheWrite, 2);
  assert.equal(t.cost, 0.0123);
  assert.equal(t.outputText, "assembled output");
});

test("createAgentDeps: sanitize-before-emit — a leaked secret is redacted in the emitted turn event, but prompt() still resolves with the RAW text for the caller to parse", async () => {
  resetCircuit();
  const leaky = "here is the key sk-abcdefghijklmnopqrstuvwxyz1234 — do not print this";
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-7" }),
    promptSession: async () => ({ parts: [{ type: "text", text: leaky }] }),
  });
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });
  const turns: AgentTurnEvent[] = [];
  const session = await deps.open("qa-generator", "/tmp", {
    descriptor: { runId: "run-88" },
    onTurn: (t) => turns.push(t),
  });
  const out = await session.prompt("do the thing");
  assert.equal(out, leaky, "the caller-facing return value stays RAW so downstream JSON/verdict parsing is never corrupted by redaction");
  assert.equal(turns.length, 1);
  assert.doesNotMatch(turns[0]!.outputText, /sk-abcdefghijklmnopqrstuvwxyz1234/, "the emitted telemetry event must never carry the raw secret");
  assert.match(turns[0]!.outputText, /\[REDACTED\]/, "the secret must be replaced with the canonical redaction marker before it reaches storage/logging");
});

test("createAgentDeps: the default turn sink calls collab.persistTurn when a runId is present and the caller supplies no onTurn override", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-8" }),
    promptSession: async () => ({ parts: [{ type: "text", text: "persisted output" }] }),
  });
  const persisted: AgentTurnEvent[] = [];
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => undefined,
    persistTurn: (t) => persisted.push(t),
  });
  const session = await deps.open("qa-generator", "/tmp", { descriptor: { runId: "run-99" } });
  await session.prompt("do the thing");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.runId, "run-99");
  assert.equal(persisted[0]!.outputText, "persisted output");
});

test("an explorer-style session (runId, liveObservation false) persists its turn under the run without being registered for live observation", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-explorer" }),
    promptSession: async () => ({ parts: [{ type: "text", text: "brief" }] }),
  });
  const persisted: AgentTurnEvent[] = [];
  const registered: string[] = [];
  const deps = withSessionRegistration(
    createAgentDeps(raw, {
      defaultPromptTimeoutMs: 5000,
      getFallbackModel: () => undefined,
      persistTurn: (t) => persisted.push(t),
    }),
    { register: (sessionId) => registered.push(sessionId), unregister: () => {} },
  );
  const session = await deps.open("qa-explorer", "/tmp", {
    descriptor: { runId: "run-7", role: "qa-explorer", liveObservation: false },
  });
  await session.prompt("map the change");
  await session.dispose();

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.runId, "run-7");
  assert.equal(persisted[0]!.role, "qa-explorer");
  assert.deepEqual(registered, []);
});

const SAMPLE_CALL_METRICS = {
  totalCalls: 7,
  stepsUsed: 3,
  callsBeforeFirstWrite: 5,
  writeCount: 1,
  redundantReadCount: 2,
  duplicateCallCount: 1,
  promptProvidedReadCount: 0,
  buckets: { code_read: 4, browser: 2, write: 1, validate_run: 0, memory: 0, subagent: 0, other: 0 },
};

async function promptWithCollaborators(
  outputText: string,
  collaborators: Partial<Parameters<typeof createAgentDeps>[1]>,
): Promise<AgentTurnEvent> {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-efficiency" }),
    promptSession: async () => ({ parts: [{ type: "text", text: outputText }] }),
  });
  const persisted: AgentTurnEvent[] = [];
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => undefined,
    persistTurn: (t) => persisted.push(t),
    ...collaborators,
  });
  const session = await deps.open("qa-generator", "/tmp", { descriptor: { runId: "run-eff" } });
  const returned = await session.prompt("the turn prompt");
  assert.equal(returned, outputText, "efficiency measurement must never alter the agent's output");
  assert.equal(persisted.length, 1);
  return persisted[0]!;
}

test("createAgentDeps: the turn event carries the tracker's call metrics for that session and prompt", async () => {
  const flushes: Array<{ sessionId: string; promptText: string }> = [];
  const turn = await promptWithCollaborators("done", {
    takeTurnCalls: (sessionId, promptText) => {
      flushes.push({ sessionId, promptText });
      return SAMPLE_CALL_METRICS;
    },
  });
  assert.deepEqual(flushes, [{ sessionId: "sess-efficiency", promptText: "the turn prompt" }]);
  assert.deepEqual(turn.callMetrics, SAMPLE_CALL_METRICS);
});

test("createAgentDeps: the step budget resolves maxSteps from the acting agent and detects exhaustion in the output", async () => {
  const asked: string[] = [];
  const exhausted = await promptWithCollaborators("CRITICAL - MAXIMUM STEPS REACHED. The maximum number of steps allowed for this task has been reached.", {
    maxStepsFor: (agent) => {
      asked.push(agent);
      return 50;
    },
  });
  assert.deepEqual(asked, ["qa-generator"]);
  assert.deepEqual(exhausted.stepBudget, { maxSteps: 50, exhausted: true });

  const finished = await promptWithCollaborators("all specs written", { maxStepsFor: () => 50 });
  assert.deepEqual(finished.stepBudget, { maxSteps: 50, exhausted: false });
});

test("createAgentDeps: an agent without a configured step limit still reports exhaustion, with a null maxSteps", async () => {
  const turn = await promptWithCollaborators("The maximum number of steps allowed for this task has been reached.", {
    maxStepsFor: () => undefined,
  });
  assert.deepEqual(turn.stepBudget, { maxSteps: null, exhausted: true });
});

test("createAgentDeps: without efficiency collaborators the turn's step budget and call metrics are null, never fabricated", async () => {
  const turn = await promptWithCollaborators("plain output", {});
  assert.equal(turn.stepBudget, null);
  assert.equal(turn.callMetrics, null);
});

test("createAgentDeps: a failing efficiency collaborator yields nulls and leaves the prompt result untouched", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => { errors.push(message); });
  const turn = await promptWithCollaborators("still fine", {
    takeTurnCalls: () => { throw new Error("tracker exploded"); },
    maxStepsFor: () => { throw new Error("config unreadable"); },
  });
  assert.equal(turn.callMetrics, null);
  assert.equal(turn.stepBudget, null);
  assert.equal(errors.length, 2, "each fault is logged loudly, never swallowed silently");
});

test("createAgentDeps: no turn sink fires when the caller supplies neither a runId nor an onTurn override (no fabricated telemetry)", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-9" }),
    promptSession: async () => ({ parts: [{ type: "text", text: "no telemetry" }] }),
  });
  let persistCalls = 0;
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => undefined,
    persistTurn: () => { persistCalls++; },
  });
  const session = await deps.open("qa-generator", "/tmp");
  const out = await session.prompt("do the thing");
  assert.equal(out, "no telemetry");
  assert.equal(persistCalls, 0, "no runId and no onTurn override means no telemetry sink fires at all");
});
