import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initCurriculum, normalizeCurriculum, classifyEvidence, foldCurriculum,
  archetypeScore, rankExemplars,
} from "@contexts/cross-run-learning/domain/curriculum.ts";
import { ALL_ARCHETYPES } from "@kernel/scenario-archetype.ts";
import { BUILT_IN_EXEMPLARS } from "@kernel/scenario-catalog.ts";

const NOW = "2026-09-04T10:00:00.000Z";

describe("initCurriculum", () => {
  it("creates all ten archetypes with zeroed, unproven counters", () => {
    const c = initCurriculum("app");
    assert.equal(c.archetypes.length, ALL_ARCHETYPES.length);
    assert.equal(c.archetypes.every((a) => !a.caughtRealBug), true);
    assert.equal(c.archetypes.every((a) => a.evaluated === 0 && a.credited === 0), true);
  });
});

describe("normalizeCurriculum", () => {
  it("defaults evaluated/credited to 0 for a pre-existing row that lacks them", () => {
    const older = {
      app: "app", updatedAt: NOW,
      archetypes: [{ archetype: "invalid-input", caughtRealBug: true, firstCaughtAt: NOW, promotionCount: 2, lastPromoted: NOW }],
    };
    const c = normalizeCurriculum(older, "app");
    const e = c.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.equal(e.caughtRealBug, true);
    assert.equal(e.promotionCount, 2);
    assert.equal(e.evaluated, 0);
    assert.equal(e.credited, 0);
  });

  it("returns a fresh curriculum for unusable input rather than throwing", () => {
    assert.equal(normalizeCurriculum(null, "app").archetypes.length, ALL_ARCHETYPES.length);
    assert.equal(normalizeCurriculum({ nope: 1 }, "app").archetypes.length, ALL_ARCHETYPES.length);
  });

  it("backfills an archetype missing from a stored curriculum", () => {
    const partial = { app: "app", updatedAt: NOW, archetypes: [] };
    assert.equal(normalizeCurriculum(partial, "app").archetypes.length, ALL_ARCHETYPES.length);
  });
});

describe("classifyEvidence", () => {
  it("app_defect is 'bug' regardless of verdict or coverage", () => {
    assert.equal(classifyEvidence({ verdict: "fail", adjudicationClass: "app_defect" }), "bug");
  });

  it("green + coverage pass is 'covered'", () => {
    assert.equal(classifyEvidence({ verdict: "pass", coverageStatus: "pass" }), "covered");
  });

  it("green + coverage fail is 'uncovered'", () => {
    assert.equal(classifyEvidence({ verdict: "pass", coverageStatus: "fail" }), "uncovered");
  });

  it("green + coverage unknown is inconclusive — unknown never becomes evidence", () => {
    assert.equal(classifyEvidence({ verdict: "pass", coverageStatus: "unknown" }), "inconclusive");
    assert.equal(classifyEvidence({ verdict: "pass" }), "inconclusive");
  });

  it("a generated_test_defect failure is inconclusive — that is the generator's fault, not the archetype's", () => {
    assert.equal(classifyEvidence({ verdict: "fail", adjudicationClass: "generated_test_defect" }), "inconclusive");
  });

  it("flaky, invalid and infra-error are inconclusive", () => {
    for (const verdict of ["flaky", "invalid", "infra-error", "skipped"] as const) {
      assert.equal(classifyEvidence({ verdict, coverageStatus: "pass" }), "inconclusive");
    }
  });
});

describe("foldCurriculum", () => {
  it("'bug' proves the archetype and credits it", () => {
    const c = foldCurriculum(initCurriculum("app"), ["invalid-input"], "bug", NOW);
    const e = c.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.deepEqual(
      { caughtRealBug: e.caughtRealBug, promotionCount: e.promotionCount, evaluated: e.evaluated, credited: e.credited, firstCaughtAt: e.firstCaughtAt },
      { caughtRealBug: true, promotionCount: 1, evaluated: 1, credited: 1, firstCaughtAt: NOW },
    );
  });

  it("does not move firstCaughtAt on a repeat bug", () => {
    const c1 = foldCurriculum(initCurriculum("app"), ["invalid-input"], "bug", NOW);
    const c2 = foldCurriculum(c1, ["invalid-input"], "bug", "2026-09-05T10:00:00.000Z");
    const e = c2.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.equal(e.firstCaughtAt, NOW);
    assert.equal(e.promotionCount, 2);
  });

  it("'covered' credits without claiming a real bug", () => {
    const c = foldCurriculum(initCurriculum("app"), ["happy-path"], "covered", NOW);
    const e = c.archetypes.find((a) => a.archetype === "happy-path")!;
    assert.deepEqual({ caughtRealBug: e.caughtRealBug, evaluated: e.evaluated, credited: e.credited }, { caughtRealBug: false, evaluated: 1, credited: 1 });
  });

  it("'uncovered' counts the attempt but grants no credit", () => {
    const c = foldCurriculum(initCurriculum("app"), ["happy-path"], "uncovered", NOW);
    const e = c.archetypes.find((a) => a.archetype === "happy-path")!;
    assert.deepEqual({ evaluated: e.evaluated, credited: e.credited }, { evaluated: 1, credited: 0 });
  });

  it("'inconclusive' is a pure no-op — the same object identity comes back", () => {
    const before = initCurriculum("app");
    assert.equal(foldCurriculum(before, ["happy-path"], "inconclusive", NOW), before);
  });

  it("an empty offered set is a pure no-op", () => {
    const before = initCurriculum("app");
    assert.equal(foldCurriculum(before, [], "covered", NOW), before);
  });

  it("folds every offered archetype, and ignores an unknown one", () => {
    const c = foldCurriculum(initCurriculum("app"), ["happy-path", "empty-state", "not-an-archetype"], "covered", NOW);
    assert.equal(c.archetypes.find((a) => a.archetype === "happy-path")!.credited, 1);
    assert.equal(c.archetypes.find((a) => a.archetype === "empty-state")!.credited, 1);
    assert.equal(c.archetypes.length, ALL_ARCHETYPES.length);
  });
});

describe("archetypeScore", () => {
  it("is the neutral 0.5 prior when never evaluated", () => {
    assert.equal(archetypeScore(initCurriculum("app").archetypes[0]!), 0.5);
  });

  it("ranks a never-tried archetype above a demonstrated-useless one", () => {
    let c = initCurriculum("app");
    for (let i = 0; i < 3; i++) c = foldCurriculum(c, ["happy-path"], "uncovered", NOW);
    const tried = c.archetypes.find((a) => a.archetype === "happy-path")!;
    const untried = c.archetypes.find((a) => a.archetype === "empty-state")!;
    assert.equal(archetypeScore(tried), 1 / 5);
    assert.equal(archetypeScore(untried), 0.5);
    assert.ok(archetypeScore(untried) > archetypeScore(tried));
  });
});

describe("rankExemplars", () => {
  const byArchetype = (a: string) => BUILT_IN_EXEMPLARS.find((e) => e.archetype === a)!;

  it("puts a proven archetype first", () => {
    const c = foldCurriculum(initCurriculum("app"), ["empty-state"], "bug", NOW);
    const ranked = rankExemplars(c, [byArchetype("happy-path"), byArchetype("empty-state")]);
    assert.equal(ranked[0]!.archetype, "empty-state");
  });

  it("orders unproven archetypes by smoothed score, best first", () => {
    let c = initCurriculum("app");
    c = foldCurriculum(c, ["happy-path"], "covered", NOW);
    c = foldCurriculum(c, ["invalid-input"], "uncovered", NOW);
    const ranked = rankExemplars(c, [byArchetype("invalid-input"), byArchetype("happy-path")]);
    assert.deepEqual(ranked.map((e) => e.archetype), ["happy-path", "invalid-input"]);
  });

  it("is stable and total: equal evidence falls back to catalog order", () => {
    const c = initCurriculum("app");
    const input = [byArchetype("boundary-value"), byArchetype("invalid-input"), byArchetype("happy-path")];
    const a = rankExemplars(c, input).map((e) => e.id);
    const b = rankExemplars(c, [...input].reverse()).map((e) => e.id);
    assert.deepEqual(a, b);
  });

  it("never drops an exemplar — ranking reorders, it does not filter", () => {
    const c = initCurriculum("app");
    assert.equal(rankExemplars(c, [...BUILT_IN_EXEMPLARS]).length, BUILT_IN_EXEMPLARS.length);
  });
});
