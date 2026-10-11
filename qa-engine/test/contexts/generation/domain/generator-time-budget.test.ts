import { test } from "node:test";
import assert from "node:assert/strict";
import { DIFF_TIER_NAMES, DIFF_TIERS, DIFF_TIME_BUDGET_MS, diffTier, type DiffStat, type DiffTier } from "@contexts/generation/domain/diff-stat.ts";
import { generatorTimeBudgetMs } from "@contexts/generation/domain/generator-time-budget.ts";
import { RUN_MODES } from "@kernel/run-mode.ts";

/* One stat inside each tier, built from the tier limits rather than re-typed. */
const STAT_OF_TIER: Record<DiffTier, DiffStat> = {
  tiny: { files: 1, added: 1, removed: 0 },
  focused: { files: DIFF_TIERS.tiny.maxFiles + 1, added: DIFF_TIERS.tiny.maxLines + 1, removed: 0 },
  broad: { files: DIFF_TIERS.focused.maxFiles + 1, added: DIFF_TIERS.focused.maxLines + 1, removed: 0 },
};

test("the stats used for each tier really fall in that tier", () => {
  for (const tier of DIFF_TIER_NAMES) assert.equal(diffTier(STAT_OF_TIER[tier]), tier);
});

for (const tier of DIFF_TIER_NAMES) {
  test(`a ${tier} diff run gets the time its tier table allows, or no extra bound when the table has none`, () => {
    const allowed = DIFF_TIME_BUDGET_MS[tier];
    const budget = generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER[tier] });
    assert.equal(budget, allowed === null ? undefined : allowed);
  });
}

test("a tiny change is held to less time than a focused one, and the broadest tier is not held to any", () => {
  const tiny = DIFF_TIME_BUDGET_MS.tiny;
  const focused = DIFF_TIME_BUDGET_MS.focused;
  assert.ok(tiny !== null && focused !== null);
  assert.ok(tiny < focused);
  assert.equal(DIFF_TIME_BUDGET_MS.broad, null);
});

test("a change exactly at a tier limit gets that tier's time, one line more gets the next tier's", () => {
  const atTiny: DiffStat = { files: DIFF_TIERS.tiny.maxFiles, added: DIFF_TIERS.tiny.maxLines, removed: 0 };
  const pastTiny: DiffStat = { ...atTiny, added: DIFF_TIERS.tiny.maxLines + 1 };
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: atTiny }), DIFF_TIME_BUDGET_MS.tiny);
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: pastTiny }), DIFF_TIME_BUDGET_MS.focused);
});

test("only a diff run is bounded by its change: every other mode keeps the default whatever the change", () => {
  for (const mode of RUN_MODES.filter((m) => m !== "diff")) {
    for (const tier of DIFF_TIER_NAMES) {
      assert.equal(generatorTimeBudgetMs({ mode, stat: STAT_OF_TIER[tier] }), undefined, `${mode}/${tier}`);
    }
  }
});

test("a tier's time is a bound only while it is shorter than the longest a single prompt may run: past that, the host's own deadline is the one that fires", () => {
  const tiny = DIFF_TIME_BUDGET_MS.tiny as number;
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.tiny, capMs: tiny + 1 }), tiny);
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.tiny, capMs: tiny }), undefined);
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.tiny, capMs: tiny - 1 }), undefined);
});

test("a tier with no bound stays unbounded whatever the cap, so the cap never becomes a bound of its own", () => {
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.broad, capMs: 1 }), undefined);
});
