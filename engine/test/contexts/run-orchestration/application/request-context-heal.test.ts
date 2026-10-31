/* RequestContextHeal: the stale flag is cleared only once the queue has accepted the rebuild, and stays armed in every other case. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestContextHeal, type EnqueueContextRunPort } from "@contexts/run-orchestration/application/index.ts";

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function run(enqueue: EnqueueContextRunPort | undefined, sha: string | undefined, parentRunId?: string) {
  const cleared: string[] = [];
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  try {
    new RequestContextHeal(enqueue, { clear: (app) => void cleared.push(app) }).execute("app", sha, parentRunId);
  } finally {
    console.warn = original;
  }
  return { cleared, warnings };
}

test("with no rebuild trigger wired the flag stays armed, with a warning", () => {
  const { cleared, warnings } = run(undefined, "abc1234");

  assert.deepEqual(cleared, []);
  assert.match(warnings[0]!, /no rebuild trigger is wired/);
});

test("a run with no sha asks for nothing and keeps the flag armed", () => {
  let asked = 0;
  const { cleared, warnings } = run(() => (asked++, "run-1"), undefined);

  assert.equal(asked, 0);
  assert.deepEqual(cleared, []);
  assert.match(warnings[0]!, /no sha/);
});

test("a queue that accepts the rebuild disarms the flag, and the request names the app, the sha and the parent run", async () => {
  const requests: unknown[] = [];
  const { cleared } = run((request) => (requests.push(request), "run-ctx-1"), "abc1234", "run-parent");
  await settle();

  assert.deepEqual(requests, [{ app: "app", sha: "abc1234", parentRunId: "run-parent" }]);
  assert.deepEqual(cleared, ["app"]);
});

test("an unlinked heal carries no parent run id", () => {
  const requests: unknown[] = [];
  run((request) => (requests.push(request), "run-ctx-1"), "abc1234");

  assert.deepEqual(requests, [{ app: "app", sha: "abc1234" }]);
});

test("a queue that refuses new work keeps the flag armed", async () => {
  const outcome = run(async () => "", "abc1234");
  await settle();

  assert.deepEqual(outcome.cleared, []);
});

test("a queue that rejects keeps the flag armed and warns with the reason", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  const cleared: string[] = [];
  try {
    new RequestContextHeal(async () => Promise.reject(new Error("queue down")), { clear: (a) => void cleared.push(a) }).execute("app", "abc1234");
    await settle();
  } finally {
    console.warn = original;
  }

  assert.deepEqual(cleared, []);
  assert.match(warnings.join("\n"), /queue down/);
});

test("a queue that throws synchronously keeps the flag armed", () => {
  const { cleared, warnings } = run(() => {
    throw new Error("boom");
  }, "abc1234");

  assert.deepEqual(cleared, []);
  assert.match(warnings[0]!, /boom/);
});
