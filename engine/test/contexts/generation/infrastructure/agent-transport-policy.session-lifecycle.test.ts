/* A transport session ends in exactly one place, its holder's dispose; a signal's abort only stops the prompt, and the orphan
   sweep collects a session nothing has used, never one a run is still holding. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentDeps, type RawAgentTransport } from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Rig {
  calls: string[];
  clock: { now: number };
  deps: ReturnType<typeof createAgentDeps>;
  /* Resolves the prompt `promptSession` is holding for a session id. */
  answer(id: string): void;
}

function rig(opts: { abortHeld?: Promise<void>; holdPrompts?: boolean; abortSettleMs?: number } = {}): Rig {
  resetCircuit();
  const calls: string[] = [];
  const clock = { now: 1_000 };
  const held = new Map<string, () => void>();
  let created = 0;
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: `sess-lifecycle-${++created}-${Math.random().toString(36).slice(2, 8)}` }),
    promptSession: (args) =>
      opts.holdPrompts
        ? new Promise((resolve) => held.set(args.id, () => resolve({ parts: [{ type: "text", text: "answer" }] })))
        : Promise.resolve({ parts: [{ type: "text", text: "answer" }] }),
    abortSession: async (id) => {
      calls.push(`abort:${id}`);
      await opts.abortHeld;
      calls.push(`abort-done:${id}`);
    },
    deleteSession: async (id) => void calls.push(`delete:${id}`),
  };
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 600_000, getFallbackModel: () => undefined, now: () => clock.now, ...(opts.abortSettleMs !== undefined ? { abortSettleMs: opts.abortSettleMs } : {}) });
  return { calls, clock, deps, answer: (id) => held.get(id)?.() };
}

const deleted = (calls: readonly string[]): string[] => calls.filter((c) => c.startsWith("delete:")).map((c) => c.slice("delete:".length));

test("a signal's abort stops the session's prompt and never deletes the session", async () => {
  const r = rig();
  const controller = new AbortController();
  const session = await r.deps.open("qa-author", "/tmp", { signal: controller.signal });
  controller.abort();
  await tick();
  assert.equal(r.calls.includes(`abort:${session.id}`), true);
  assert.deepEqual(deleted(r.calls), []);
  await session.dispose();
});

test("the holder's dispose deletes the session once, however many times it is asked", async () => {
  const r = rig();
  const session = await r.deps.open("qa-author", "/tmp");
  await session.dispose();
  await session.dispose();
  assert.deepEqual(deleted(r.calls), [session.id]);
});

test("a dispose that follows an abort deletes the session only after the abort has finished, so no delete races a write still in flight", async () => {
  let finishAbort!: () => void;
  const r = rig({ abortHeld: new Promise<void>((resolve) => { finishAbort = resolve; }) });
  const controller = new AbortController();
  const session = await r.deps.open("qa-author", "/tmp", { signal: controller.signal });
  controller.abort();
  await tick();
  const disposing = session.dispose();
  await tick();
  assert.deepEqual(deleted(r.calls), [], "the abort has not finished");
  finishAbort();
  await disposing;
  assert.deepEqual(r.calls, [`abort:${session.id}`, `abort-done:${session.id}`, `delete:${session.id}`]);
});

test("the orphan sweep collects a session nothing has used for longer than the threshold, and keeps one that was used within it", async () => {
  const r = rig();
  const idle = await r.deps.open("qa-lead", "/tmp");
  const used = await r.deps.open("qa-lead", "/tmp");
  r.clock.now += 90;
  await used.prompt("a turn");
  r.clock.now += 60;
  await r.deps.cleanupOrphans!(100);
  assert.deepEqual(deleted(r.calls).filter((id) => id === idle.id || id === used.id), [idle.id], "the session used 60 ms ago is a live one");
  await used.dispose();
  await idle.dispose();
});

test("the orphan sweep never collects a session with a prompt in flight, however long ago it was opened", async () => {
  const r = rig({ holdPrompts: true });
  const session = await r.deps.open("qa-author", "/tmp");
  const answering = session.prompt("a long turn");
  await tick();
  r.clock.now += 10_000;
  await r.deps.cleanupOrphans!(100);
  assert.equal(deleted(r.calls).includes(session.id), false);
  r.answer(session.id);
  await answering;
  await r.deps.cleanupOrphans!(100);
  assert.equal(deleted(r.calls).includes(session.id), false, "the end of the turn is a use: the idle time counts from it");
  r.clock.now += 101;
  await r.deps.cleanupOrphans!(100);
  assert.equal(deleted(r.calls).includes(session.id), true);
});

test("a dispose stops waiting for an abort the runtime never answers and deletes the session anyway", async () => {
  const r = rig({ abortHeld: new Promise<void>(() => {}), abortSettleMs: 20 });
  const controller = new AbortController();
  const session = await r.deps.open("qa-author", "/tmp", { signal: controller.signal });
  controller.abort();
  await tick();
  await session.dispose();
  assert.deepEqual(deleted(r.calls), [session.id]);
});
