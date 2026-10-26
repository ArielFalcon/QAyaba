/* buildObjectiveSignal: the returned API serves the objective-signal port and the intent contract parser, and the port reads the collaborators it was built from. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { buildObjectiveSignal } from "@contexts/objective-signal/composition/build-objective-signal.ts";

const base = {
  oracle: { measure: async () => ({ kind: "unavailable", reason: "fake" }) } as never,
  policy: { mode: "signal", minRatio: 0.7 } as never,
  repoDir: "/repo",
  namespace: "ns",
};

test("the objective signal measures through the oracle it was built from, in the namespace it was given", async () => {
  const asked: Array<{ repoDir: string; namespace: string }> = [];
  const api = buildObjectiveSignal({
    ...base,
    oracle: { measure: async (_br, repoDir, namespace) => { asked.push({ repoDir, namespace }); return { valueScore: 0.5, mutantCount: 2, killedCount: 1 } as never; } },
    collector: { collect: async () => ({}) as never },
  });

  const measured = await api.objectiveSignal.measure(BlastRadius.of(Sha.of("abc1234"), ["src/a.ts"]), "/repo/e2e");

  assert.deepEqual(asked, [{ repoDir: "/repo", namespace: "ns" }]);
  assert.equal(measured.status, "unknown");
  assert.equal(measured.valueScore, 0.5);
});

test("only an enforced failing measurement blocks", () => {
  const api = buildObjectiveSignal({ ...base, policy: { mode: "enforce", minRatio: 0.7 } as never, collector: { collect: async () => ({}) as never } });

  assert.equal(api.objectiveSignal.blocks("fail"), true);
  assert.equal(api.objectiveSignal.blocks("unknown"), false);
});

test("the intent contract parser extracts a spec's declared tests", () => {
  const api = buildObjectiveSignal({ ...base, collector: { collect: async () => ({}) as never } });

  const extraction = api.intentContract.extract("e2e/cart.spec.ts", 'import { test } from "@playwright/test";\ntest("shows the cart", async ({ page }) => { await page.goto("/"); });\n');

  assert.ok(extraction);
});
