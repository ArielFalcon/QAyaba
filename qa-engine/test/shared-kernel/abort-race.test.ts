import { test } from "node:test";
import assert from "node:assert/strict";
import { AbortRaceError, isAbortError, raceWithAbort } from "@kernel/abort-race.ts";

test("a signal that is already aborted rejects at once with the abort error", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(raceWithAbort(new Promise<never>(() => {}), controller.signal), (err) => err instanceof AbortRaceError && isAbortError(err));
});

test("an abort while the collaborator is pending rejects without waiting for it", async () => {
  const controller = new AbortController();
  const pending = raceWithAbort(new Promise<never>(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, (err) => isAbortError(err));
});

test("the collaborator's value wins when it settles first, and its rejection passes through unchanged", async () => {
  const controller = new AbortController();
  assert.equal(await raceWithAbort(Promise.resolve(7), controller.signal), 7);
  const failure = new Error("render failed");
  await assert.rejects(raceWithAbort(Promise.reject(failure), controller.signal), (err) => err === failure && !isAbortError(err));
});

test("a settled race no longer listens to the signal", async () => {
  const controller = new AbortController();
  let removed = 0;
  const signal = controller.signal;
  const original = signal.removeEventListener.bind(signal);
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed++;
    return original(...args);
  }) as AbortSignal["removeEventListener"];
  await raceWithAbort(Promise.resolve(1), signal);
  assert.equal(removed, 1);
});

test("isAbortError recognises an error named AbortError and nothing else", () => {
  const named = new Error("x");
  named.name = "AbortError";
  assert.equal(isAbortError(named), true);
  assert.equal(isAbortError(new Error("x")), false);
  assert.equal(isAbortError("AbortError"), false);
});
