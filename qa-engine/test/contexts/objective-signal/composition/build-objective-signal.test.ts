/* buildObjectiveSignal: the returned API serves the objective-signal port and the intent contract parser, and the port reads the collaborators it was built from. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { buildObjectiveSignal } from "@contexts/objective-signal/composition/build-objective-signal.ts";

const base = {
  policy: { mode: "signal", minRatio: 0.7 } as never,
  repoDir: "/repo",
  namespace: "ns",
};

test("the objective signal measures the collector it was built from, in the namespace it was given", async () => {
  const asked: Array<{ specDir: string; namespace: string }> = [];
  const api = buildObjectiveSignal({
    ...base,
    collector: { collect: async (specDir, namespace) => { asked.push({ specDir, namespace }); return {} as never; } },
    assembleChangeCoverage: () => ({ measured: false, overall: { changedLines: 0, coveredChanged: 0, ratio: 0 }, perFile: [], uncovered: [] }) as never,
  });

  const measured = await api.objectiveSignal.measure(BlastRadius.of(Sha.of("abc1234"), ["src/a.ts"]), "/repo/e2e", "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+x");

  assert.deepEqual(asked, [{ specDir: "/repo/e2e", namespace: "ns" }]);
  assert.equal(measured.status, "unknown");
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
