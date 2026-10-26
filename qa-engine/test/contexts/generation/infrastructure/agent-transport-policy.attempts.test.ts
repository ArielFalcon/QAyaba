/* What the transport policy reports to a trace: attempts, the model that answered, the error class, the limits and the hash of the bytes sent. Observing must change nothing about how a prompt ends. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import { createAgentDeps, type AgentTurnEvent, type RawAgentTransport, type RawPromptResult, type AttemptEvent } from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { CIRCUIT_THRESHOLD, resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";
import { carriedAgentErrorType } from "@contexts/generation/domain/agent-error-class.ts";

const answered = (extra: Partial<RawPromptResult> = {}): RawPromptResult => ({
  parts: [{ type: "text", text: "done" }],
  tokens: { input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 0 },
  cost: 0.01,
  answered: { modelId: "m-answer", providerId: "p-answer", finish: "stop", createdAt: 100, completedAt: 400 },
  ...extra,
});

function transport(promptSession: RawAgentTransport["promptSession"]): RawAgentTransport {
  return { createSession: async () => ({ id: "sess-t" }), promptSession, abortSession: async () => {}, deleteSession: async () => {} };
}

function observed(raw: RawAgentTransport, collab: Partial<Parameters<typeof createAgentDeps>[1]> = {}) {
  resetCircuit();
  const events: AttemptEvent[] = [];
  const turns: AgentTurnEvent[] = [];
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5_000,
    getFallbackModel: () => undefined,
    persistTurn: (t) => turns.push(t),
    onAttempt: (sessionId, event) => {
      assert.equal(sessionId, "sess-t");
      events.push(event);
    },
    ...collab,
  });
  return { deps, events, turns };
}

test("a prompt that is answered reports one attempt, from start to end, with the model that answered and the usage", async () => {
  const { deps, events } = observed(transport(async () => answered()));
  const session = await deps.open("qa-generator", "/w", { model: "prov/asked-model", descriptor: { runId: "r1", role: "qa-generator" } });
  assert.equal(await session.prompt("hello"), "done");

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ["start", "end", "turn"]);
  const start = events[0]!;
  const end = events[1]!;
  assert.ok(start.kind === "start" && end.kind === "end");
  assert.equal(start.attempt, 1);
  assert.equal(start.requestedModel, "prov/asked-model");
  assert.equal(end.attempt, 1);
  assert.deepEqual(end.answered, { modelId: "m-answer", providerId: "p-answer", finish: "stop", createdAt: 100, completedAt: 400 });
  assert.deepEqual(end.usage, { input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 0, cost: 0.01 });
  assert.equal(end.errorType, undefined);
});

test("the persisted turn names the model asked for and the one that answered, the attempt, and the hash of the bytes sent", async () => {
  const { deps, turns } = observed(transport(async () => answered()));
  const session = await deps.open("qa-generator", "/w", { model: "prov/asked-model", descriptor: { runId: "r1", role: "qa-generator" } });
  await session.prompt("hello world", { sectionHashes: { task: "abc" }, sectionSizes: { task: 11 } });

  const turn = turns[0]!;
  assert.equal(turn.modelRequested, "prov/asked-model");
  assert.equal(turn.modelAnswered, "m-answer");
  assert.equal(turn.provider, "p-answer");
  assert.equal(turn.attempt, 1);
  assert.equal(turn.fallbackUsed, false);
  assert.equal(turn.errorType, null);
  assert.deepEqual(turn.sectionHashes, { task: "abc" });
  assert.equal(turn.promptHash, createHash("sha256").update("hello world", "utf8").digest("hex"));
  assert.equal(turn.limitApplied, "host-cap");
  assert.equal(turn.limitFired, null);
});

test("the hash is of the bytes actually sent: the run's secrets are already out of them", async () => {
  const { deps, turns } = observed(transport(async () => answered()));
  const secrets = createRunSecretScope();
  secrets.addAccountSecrets(["s3cr3t-passw0rd"]);
  await withRunSecretScope(secrets, async () => {
    const session = await deps.open("qa-generator", "/w", { descriptor: { runId: "r1", role: "qa-generator" } });
    await session.prompt("use s3cr3t-passw0rd to log in");
  });
  const turn = turns[0]!;
  assert.equal(turn.promptHash, createHash("sha256").update(turn.promptText, "utf8").digest("hex"));
  assert.ok(!turn.promptText.includes("s3cr3t-passw0rd"));
});

test("a primary-model fault that the fallback recovers is two attempts, the second marked, and the turn says the fallback answered", async () => {
  let calls = 0;
  const { deps, events, turns } = observed(
    transport(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
      return answered({ answered: { modelId: "m-fallback", providerId: "p-fallback" } });
    }),
    { getFallbackModel: () => "prov/fallback-model" },
  );
  const session = await deps.open("qa-generator", "/w", { model: "prov/primary", descriptor: { runId: "r1", role: "qa-generator" } });
  assert.equal(await session.prompt("hello"), "done");

  assert.deepEqual(events.map((e) => (e.kind === "start" || e.kind === "end" ? `${e.kind}${e.attempt}` : e.kind)), ["start1", "end1", "fallback", "start2", "end2", "turn"]);
  const firstEnd = events[1]!;
  assert.ok(firstEnd.kind === "end");
  assert.equal(firstEnd.errorType, "socket_closed");
  const second = events[3]!;
  assert.ok(second.kind === "start");
  assert.equal(second.requestedModel, "prov/fallback-model");
  assert.equal(turns[0]!.attempt, 2);
  assert.equal(turns[0]!.fallbackUsed, true);
  assert.equal(turns[0]!.modelRequested, "prov/fallback-model");
  assert.equal(turns[0]!.errorType, "socket_closed");
});

test("a provider error embedded in the answer is classified, reaches the attempt, and rides the thrown error", async () => {
  const { deps, events } = observed(transport(async () => ({ parts: [], agentError: { name: "APIError", data: { statusCode: 429, message: "You exceeded your current quota" } } })));
  const session = await deps.open("qa-generator", "/w", { descriptor: { runId: "r1", role: "qa-generator" } });
  await assert.rejects(session.prompt("hello"), (err: unknown) => carriedAgentErrorType(err) === "quota_exceeded" && !("agentErrorType" in (err as object)));
  const end = events.find((e) => e.kind === "end");
  assert.ok(end && end.kind === "end");
  assert.equal(end.errorType, "quota_exceeded");
  assert.equal(events.filter((e) => e.kind === "end").length, 1, "an attempt ends once");
});

test("a prompt cut by its own time limit reports which limit it was, and the turn is recorded as timed out", async () => {
  const { deps, events, turns } = observed(transport(() => new Promise(() => {})));
  const session = await deps.open("qa-generator", "/w", { descriptor: { runId: "r1", role: "qa-generator" } });
  await assert.rejects(session.prompt("hello", { timeoutMs: 5, timeLimit: "repair-cap" }), AgentTimeoutError);

  const start = events[0]!;
  assert.ok(start.kind === "start");
  assert.deepEqual(start.limitApplied, { source: "repair-cap", ms: 5 });
  assert.equal(turns[0]!.limitApplied, "repair-cap");
  assert.equal(turns[0]!.limitFired, "repair-cap");
  assert.equal(turns[0]!.errorType, "timeout");
  const turn = events.at(-1)!;
  assert.ok(turn.kind === "turn");
  assert.equal(turn.turn.ended, "timeout");
  const end = events.find((e) => e.kind === "end");
  assert.ok(end && end.kind === "end", "an attempt that never answered is closed when its turn is");
  assert.equal(end.abandoned, true);
});

test("the limit that applies is named by its source: the prompt's, else the session's, else the host's", async () => {
  const { deps, turns } = observed(transport(async () => answered()));
  const session = await deps.open("qa-generator", "/w", { timeoutMs: 4_000, timeLimit: "session-timeout", descriptor: { runId: "r1", role: "qa-judge" } });
  await session.prompt("a");
  await session.prompt("b", { timeoutMs: 3_000 });
  assert.deepEqual(turns.map((t) => t.limitApplied), ["session-timeout", "prompt-budget"]);
  const plain = await deps.open("qa-generator", "/w", { timeoutMs: 4_000, descriptor: { runId: "r1", role: "qa-judge" } });
  await plain.prompt("c");
  assert.equal(turns[2]!.limitApplied, "session-timeout");
});

test("a turn that used every step it had is recorded as cut by the step cap", async () => {
  const { deps, turns } = observed(transport(async () => answered({ parts: [{ type: "text", text: "CRITICAL - MAXIMUM STEPS REACHED" }] })), { takeTurnCalls: () => ({ stepsUsed: 25 }) as never, maxStepsFor: () => 25 });
  const session = await deps.open("qa-generator", "/w", { descriptor: { runId: "r1", role: "qa-generator" } });
  await session.prompt("hello", { stepLimit: 25 });
  assert.equal(turns[0]!.ended, "exhausted");
  assert.equal(turns[0]!.limitFired, "step-cap");
});

test("an abort from the caller is recorded as a cancel", async () => {
  const controller = new AbortController();
  let failPrompt: (err: Error) => void = () => {};
  const raw: RawAgentTransport = {
    ...transport(() => new Promise((_resolve, reject) => { failPrompt = reject; })),
    abortSession: async () => failPrompt(new Error("the session was aborted")),
  };
  const { deps, turns } = observed(raw);
  const session = await deps.open("qa-generator", "/w", { signal: controller.signal, descriptor: { runId: "r1", role: "qa-generator" } });
  const pending = session.prompt("hello");
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(turns[0]!.ended, "aborted");
  assert.equal(turns[0]!.limitFired, "cancel");
  assert.equal(turns[0]!.errorType, "aborted");
});

test("a limit an outer layer fired (the stall watchdog) is recorded on the turn the inner layer closes", async () => {
  const { deps, turns } = observed(transport(() => new Promise(() => {})), { outerLimit: () => "stall" });
  const session = await deps.open("qa-generator", "/w", { descriptor: { runId: "r1", role: "qa-generator" } });
  await assert.rejects(session.prompt("hello", { timeoutMs: 5 }));
  assert.equal(turns[0]!.limitFired, "stall");
});

test("observing changes nothing: the same prompts end the same way with the hook, with a throwing hook, and without one", async () => {
  async function run(collab: Partial<Parameters<typeof createAgentDeps>[1]>): Promise<{ outcomes: string[]; rows: unknown[] }> {
    resetCircuit();
    let calls = 0;
    const rows: unknown[] = [];
    const raw = transport(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      if (calls === 3) return { parts: [], agentError: { name: "ProviderAuthError" } };
      return answered();
    });
    const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5_000, getFallbackModel: () => "prov/fb", persistTurn: ({ ts: _ts, durationMs: _d, ...rest }) => rows.push(rest), ...collab });
    const session = await deps.open("qa-generator", "/w", { descriptor: { runId: "r1", role: "qa-generator" } });
    const outcomes: string[] = [];
    for (const text of ["one", "two"]) {
      try {
        outcomes.push(await session.prompt(text));
      } catch (err) {
        outcomes.push(`${(err as Error).name}: ${(err as Error).message}`);
      }
    }
    return { outcomes, rows };
  }
  const plain = await run({});
  const hooked = await run({ onAttempt: () => {} });
  const throwing = await run({ onAttempt: () => { throw new Error("hook exploded"); } });
  assert.deepEqual(hooked.outcomes, plain.outcomes);
  assert.deepEqual(throwing.outcomes, plain.outcomes);
  assert.deepEqual(hooked.rows, plain.rows);
  assert.deepEqual(throwing.rows, plain.rows);
});

test("an error whose cause chain loops reaches the caller as it is, and the breaker still counts the failure", async () => {
  const a = new Error("looping fault");
  const b = new Error("inner");
  (a as { cause?: unknown }).cause = b;
  (b as { cause?: unknown }).cause = a;
  const { deps, events } = observed(transport(async () => { throw a; }));
  const session = await deps.open("qa-generator", "/w", { descriptor: { runId: "r1", role: "qa-generator" } });
  let reachedCaller = 0;
  for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
    try {
      await session.prompt("hello");
    } catch (err) {
      if (err !== a) break;
      reachedCaller += 1;
    }
  }
  assert.ok(reachedCaller > 0, "the original error reached the caller");
  const end = events.find((e) => e.kind === "end");
  assert.ok(end && end.kind === "end");
  assert.equal(end.errorType, "unknown");
  assert.throws(() => session.prompt("hello"), /circuit breaker is OPEN/);
});
