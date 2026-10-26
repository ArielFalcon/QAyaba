import { test } from "node:test";
import assert from "node:assert/strict";
import { DIFF_TIER_NAMES, DIFF_TIERS, DIFF_TIME_BUDGET_MS, diffTier, type DiffStat, type DiffTier } from "@kernel/diff-stat.ts";
import { DIFF_TIME_BUDGET_ENV, generatorTimeBudgetMs, resolveDiffTimeBudgets } from "@contexts/generation/domain/generator-time-budget.ts";
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

test("a budget table handed in replaces the default for the tier the change falls in, and only for that tier", () => {
  const budgets = { tiny: 90_000, focused: null, broad: 3_600_000 };
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.tiny, budgets }), 90_000);
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.focused, budgets }), undefined, "a tier the table leaves unbounded stays so");
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.broad, budgets }), 3_600_000, "a tier the default leaves unbounded can be given a bound");
});

test("a table handed in is still clamped by the host's own deadline: a time that deadline does not exceed is no bound", () => {
  const budgets = { tiny: 600_000, focused: 600_000, broad: 600_000 };
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.tiny, budgets, capMs: 600_001 }), 600_000);
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.tiny, budgets, capMs: 600_000 }), undefined);
  assert.equal(generatorTimeBudgetMs({ mode: "diff", stat: STAT_OF_TIER.broad, budgets, capMs: 1_000 }), undefined);
});

test("with no override in the environment the budgets are exactly the defaults", () => {
  assert.deepEqual(resolveDiffTimeBudgets({}), DIFF_TIME_BUDGET_MS);
  assert.deepEqual(resolveDiffTimeBudgets({ UNRELATED: "1" }), DIFF_TIME_BUDGET_MS);
});

test("each tier is overridden by its own variable, leaving the others at their defaults", () => {
  for (const tier of DIFF_TIER_NAMES) {
    const budgets = resolveDiffTimeBudgets({ [DIFF_TIME_BUDGET_ENV[tier]]: "123456" });
    for (const other of DIFF_TIER_NAMES) assert.equal(budgets[other], other === tier ? 123_456 : DIFF_TIME_BUDGET_MS[other], `${tier} override seen on ${other}`);
  }
});

test("a blank variable is no override, and 'none' removes a tier's bound", () => {
  const budgets = resolveDiffTimeBudgets({ [DIFF_TIME_BUDGET_ENV.tiny]: "  ", [DIFF_TIME_BUDGET_ENV.focused]: "none", [DIFF_TIME_BUDGET_ENV.broad]: "NONE" });
  assert.deepEqual(budgets, { tiny: DIFF_TIME_BUDGET_MS.tiny, focused: null, broad: null });
});

test("a value that is not a positive whole number of milliseconds fails loudly, naming the variable and the value", () => {
  for (const bad of ["0", "-5", "1.5", "6min", "1e3", "abc", "0x10", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(
      () => resolveDiffTimeBudgets({ [DIFF_TIME_BUDGET_ENV.focused]: bad }),
      (err: unknown) => err instanceof Error && err.message.includes(DIFF_TIME_BUDGET_ENV.focused) && err.message.includes(JSON.stringify(bad)),
      bad,
    );
  }
});

test("the variables are named per tier so a new tier cannot be added without one", () => {
  assert.deepEqual(Object.keys(DIFF_TIME_BUDGET_ENV).sort(), [...DIFF_TIER_NAMES].sort());
  assert.equal(new Set(Object.values(DIFF_TIME_BUDGET_ENV)).size, DIFF_TIER_NAMES.length);
});
