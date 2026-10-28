/* test/contexts/run-orchestration/infrastructure/adapters/objective-signal-port.adapter.test.ts
   ObjectiveSignalPortAdapter composes the REAL keystone collaborators — CoverageCollectorPort.collect
   (raw covered lines), the assembler (diff + raw CoverageReport -> ChangeCoverage read-model),
   DecideCoverageService.decide (the keystone: unknown NEVER blocks — consumed VERBATIM, never
   reimplemented) and ValueOraclePort.measure (the mutation-testing / fault-injection valueScore).
   THIN — no new coverage-ratio logic added here.
   The assembler is wired via qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts
   (see that module's own tests for the assembler's correctness). This suite exercises the ADAPTER:
   diff present + assembler -> real
   status/ratio; diff absent -> unknown; assembler absent -> unknown; the namespace fix; and the
   changedFiles threading into collect()'s optional trailing arg.
 */
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { ObjectiveSignalPortAdapter } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts";
import { DecideCoverageService, type ChangeCoverage } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import type { CoverageCollectorPort } from "@contexts/objective-signal/application/ports/coverage-collector.port.ts";
import type { ValueOraclePort } from "@contexts/objective-signal/application/ports/value-oracle.port.ts";
import type { CoverageReport, ValueOracleResult } from "@contexts/objective-signal/domain/coverage-collector.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

function fakeCollector(report: CoverageReport, onCollect?: (specDir: string, namespace: string, changedFiles?: string[]) => void): CoverageCollectorPort {
  return {
    collect: async (specDir, namespace, changedFiles) => {
      onCollect?.(specDir, namespace, changedFiles);
      return report;
    },
  };
}
function fakeOracle(result: ValueOracleResult): ValueOraclePort {
  return { measure: async () => result };
}

const SAMPLE_DIFF = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "@@ -1,0 +1,2 @@",
  "+a",
  "+b",
].join("\n");

test("measure() returns unknown+null when no ChangeCoverage assembler is injected (keystone-safe default)", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2, 3] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.equal(result.status, "unknown");
  assert.equal(result.ratio, null);
});

test("measure() returns unknown+null when an assembler IS injected but diff is absent (non-diff modes)", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.equal(result.status, "unknown", "an assembler with no diff must never fabricate a status");
  assert.equal(result.ratio, null);
});

test("measure() short-circuits the collector's IO entirely when no assembly will happen", async () => {
  let collectCalls = 0;
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] }, () => { collectCalls++; });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: 0.5, mutantCount: 2, killedCount: 1, details: "" });
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);

  /* Case 1: assembler wired, diff absent (non-diff modes / cross-repo starved diff) -> no collection. */
  const withAssembler = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
  const starved = await withAssembler.measure(br, "/mirrors/org/app/e2e");
  assert.equal(collectCalls, 0, "no diff -> the collector's real IO must be skipped, not run-and-discarded");
  assert.equal(starved.status, "unknown");
  assert.equal(starved.valueScore, 0.5, "the value-oracle still runs — only coverage collection is skipped");

  const withoutAssembler = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" },
  );
  await withoutAssembler.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);
  assert.equal(collectCalls, 0, "no assembler -> the collector's real IO must be skipped");

  await withAssembler.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);
  assert.equal(collectCalls, 1, "assembler + diff -> collection runs (the only consumer of the report)");
});

test("measure() delegates to the injected ChangeCoverageAssembler + DecideCoverageService.decide verbatim", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const spy = (diff: string, report: CoverageReport): ChangeCoverage => assembleChangeCoverage(diff, report);
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage: spy },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.equal(result.status, "pass");
  assert.equal(result.ratio, 1);
});

test("measure() surfaces uncovered from the assembled ChangeCoverage when willAssemble is true", async () => {
  /* SAMPLE_DIFF adds src/checkout.ts lines 1-2; the collector reports NOTHING covered there, so
     both diff lines are uncovered — assembleChangeCoverage's real output threads through measure().
   */
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.deepEqual(result.uncovered, [{ file: "src/checkout.ts", lines: [1, 2] }], "uncovered lines from the assembled ChangeCoverage must surface on the measure() result");
});

test("measure() omits uncovered (undefined, never []) when willAssemble is false — no assembler, or assembler present but diff absent", async () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);

  const withoutAssembler = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" },
  );
  const resultNoAssembler = await withoutAssembler.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);
  assert.equal(resultNoAssembler.uncovered, undefined, "no assembler -> uncovered must be absent, never fabricated as []");

  const withAssembler = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
  const resultNoDiff = await withAssembler.measure(br, "/mirrors/org/app/e2e");
  assert.equal(resultNoDiff.uncovered, undefined, "assembler present but diff absent -> uncovered must be absent");
});

test("measure() surfaces valueScore from the injected ValueOraclePort (the mutation-testing keystone companion)", async () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: 0.85, mutantCount: 20, killedCount: 17, details: "17/20 mutants killed" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.equal(result.valueScore, 0.85);
  assert.equal(result.mutantCount, 20, "the oracle's real mutantCount must reach the caller, not be dropped on the floor");
  assert.equal(result.killedCount, 17, "the oracle's real killedCount must reach the caller, not be dropped on the floor");
});

test("measure() surfaces a null mutantCount/killedCount from the injected ValueOraclePort as-is (distinct from 'ran and found zero')", async () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "valueOracle is off" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.equal(result.mutantCount, null);
  assert.equal(result.killedCount, null);
});

/* ── NAMESPACE FIX ────────────────────────────────────────────────────────────────────────────── */

/* Collection is observable only on the assemble path (assembler wired + diff supplied);
   otherwise collect() is skipped entirely. */

test("measure() uses ctx.namespace (the SAME per-run namespace ExecutionPortAdapter uses), not br.sha.toString()", async () => {
  const seenNamespaces: string[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, namespace) => seenNamespaces.push(namespace));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", namespace: "qa-bot-abc1234", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.deepEqual(seenNamespaces, ["qa-bot-abc1234"], "the collector must be queried under the SAME namespace execution wrote dumps to");
});

test("measure() falls back to br.sha.toString() when ctx.namespace is absent (backward compatible)", async () => {
  const seenNamespaces: string[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, namespace) => seenNamespaces.push(namespace));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.deepEqual(seenNamespaces, ["abc1234"]);
});

/* opts.namespace is a PER-CALL override that must take precedence over the composition-time
   ctx.namespace (`o.namespace ?? this.ctx.namespace`, same as ExecutionOpts.namespace). Without
   this override, the enforce-mode regen's re-measure() call has no way to read its OWN
   `${runId}-coverage-regen` dumps — it silently falls back to the first run's dumps.
 */
test("measure() opts.namespace overrides ctx.namespace for the collector call (per-call regen escape hatch)", async () => {
  const seenNamespaces: string[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, namespace) => seenNamespaces.push(namespace));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", namespace: "qa-bot-abc1234", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF, undefined, { namespace: "qa-bot-abc1234-coverage-regen" });

  assert.deepEqual(seenNamespaces, ["qa-bot-abc1234-coverage-regen"], "opts.namespace must override ctx.namespace so the regen's re-measure reads its OWN coverage dumps, never the first run's");
});

test("measure() falls back to ctx.namespace when opts.namespace is absent (backward compatible — every pre-existing caller unaffected)", async () => {
  const seenNamespaces: string[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, namespace) => seenNamespaces.push(namespace));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", namespace: "qa-bot-abc1234", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF, undefined, {});

  assert.deepEqual(seenNamespaces, ["qa-bot-abc1234"], "an opts bag with no namespace field must fall back to ctx.namespace unchanged");
});

/* ── CHANGED-FILES THREADING ─────────────────────────────────────────────────────────────────── */

test("measure() derives changedFiles from the diff and threads them into collect()'s optional trailing arg", async () => {
  const seenChangedFiles: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, _namespace, changedFiles) => seenChangedFiles.push(changedFiles));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.deepEqual(seenChangedFiles, [["src/checkout.ts"]]);
});

/* Per-call baselineCases: the e2e fault-injection oracle returns valueScore:null forever unless
   it knows the green run's passing spec names; the composition root's static ctx.baselineCases is
   a permanent [] placeholder (no per-run case list exists at composition time) — the PER-CALL arg
   is what supplies a real value.
 */

test("measure() forwards a PER-CALL baselineCases arg into ValueOraclePort.measure, taking precedence over ctx.baselineCases", async () => {
  const seenBaselineCases: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle: ValueOraclePort = {
    measure: async (_br, _repoDir, _namespace, baselineCases) => {
      seenBaselineCases.push(baselineCases);
      return { valueScore: 0.9, mutantCount: 10, killedCount: 9, details: "9/10" };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", baselineCases: ["stale-static-case"] },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", undefined, ["login", "checkout"]);

  assert.deepEqual(seenBaselineCases, [["login", "checkout"]], "the per-call baselineCases must win over the static ctx.baselineCases placeholder");
  assert.equal(result.valueScore, 0.9);
});

test("measure() falls back to ctx.baselineCases when the per-call arg is absent (backward compatible)", async () => {
  const seenBaselineCases: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle: ValueOraclePort = {
    measure: async (_br, _repoDir, _namespace, baselineCases) => {
      seenBaselineCases.push(baselineCases);
      return { valueScore: null, mutantCount: 0, killedCount: 0, details: "" };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", baselineCases: ["ctx-fallback-case"] },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e"); /* no baselineCases arg at all */

  assert.deepEqual(seenBaselineCases, [["ctx-fallback-case"]]);
});

test("measure() passes undefined to the oracle when NEITHER a per-call arg NOR ctx.baselineCases is supplied", async () => {
  const seenBaselineCases: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle: ValueOraclePort = {
    measure: async (_br, _repoDir, _namespace, baselineCases) => {
      seenBaselineCases.push(baselineCases);
      return { valueScore: null, mutantCount: 0, killedCount: 0, details: "" };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.deepEqual(seenBaselineCases, [undefined]);
});

/* ObjectiveSignalPort.blocks() delegates to DecideCoverageService.blocks() VERBATIM — "enforce" +
   "fail" is the ONLY combination that blocks; every other combination must NOT. The use-case asks
   the port for the decision instead of re-reading a duplicated mode string.
 */

test("blocks() delegates to DecideCoverageService.blocks() verbatim: enforce+fail -> true", () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  assert.equal(adapter.blocks("fail"), true, "enforce mode + fail status must block");
});

test("blocks(): signal+fail -> false (signal mode never blocks, regardless of status)", () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  assert.equal(adapter.blocks("fail"), false, "signal mode must never block, even on fail");
});

test("blocks(): enforce+unknown -> false (the keystone invariant — unknown NEVER blocks)", () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  assert.equal(adapter.blocks("unknown"), false, "unknown must never block even in enforce mode");
});

test("blocks(): enforce+pass -> false", () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  assert.equal(adapter.blocks("pass"), false, "a pass status must never block");
});

/* coveragePolicy.mode "off" must skip BOTH collector IO and the value oracle (YAML honesty). */
test("measure() with policy.mode off skips collector and oracle", async () => {
  let collectCalls = 0;
  let oracleCalls = 0;
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] }, () => { collectCalls++; });
  const decide = new DecideCoverageService();
  const oracle: ValueOraclePort = {
    measure: async () => {
      oracleCalls++;
      return { valueScore: 0.9, mutantCount: 2, killedCount: 2, details: "should not run" };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "off", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF, ["a"]);

  assert.equal(collectCalls, 0, "coverage.mode off must not collect coverage dumps");
  assert.equal(oracleCalls, 0, "coverage.mode off must not run the value oracle");
  assert.equal(result.status, "unknown");
  assert.equal(result.ratio, null);
  assert.equal(result.valueScore, undefined);
  assert.equal(result.mutantCount, undefined, "the oracle never ran — mutantCount must be absent, never a fabricated 0 or null");
  assert.equal(result.killedCount, undefined, "the oracle never ran — killedCount must be absent, never a fabricated 0 or null");
});

test("measure() says why a change-coverage is unknown: no executed source mapped to a changed file, no diff, no assembler", async () => {
  const oracle = fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" });
  const adapterWith = (report: CoverageReport, assembler = true) =>
    new ObjectiveSignalPortAdapter({ collector: fakeCollector(report), decide: new DecideCoverageService(), oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/r", ...(assembler ? { assembleChangeCoverage } : {}) });
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);

  const unmapped = await adapterWith({ covered: [] }).measure(br, "/r/e2e", SAMPLE_DIFF);
  assert.equal(unmapped.status, "unknown");
  assert.deepEqual(unmapped.measurement, { changedLines: 2, coveredChanged: 0, changedFiles: 1, mappedFiles: 0, unmeasured: "no-changed-file-mapped" });

  const measured = await adapterWith({ covered: [{ file: "src/checkout.ts", lines: [1] }] }).measure(br, "/r/e2e", SAMPLE_DIFF);
  assert.deepEqual(measured.measurement, { changedLines: 2, coveredChanged: 1, changedFiles: 1, mappedFiles: 1 });

  assert.equal((await adapterWith({ covered: [] }).measure(br, "/r/e2e")).measurement?.unmeasured, "no-diff");
  assert.equal((await adapterWith({ covered: [] }, false).measure(br, "/r/e2e", SAMPLE_DIFF)).measurement?.unmeasured, "not-assembled");
});

test("measure() says the scripts carried no source map when the dumps held scripts, none had one and no changed file mapped; it never blocks", async () => {
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const make = (report: CoverageReport) => new ObjectiveSignalPortAdapter(
    { collector: fakeCollector(report), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" }) },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage: assembleChangeCoverage },
  );

  const bundled = await make({ covered: [], scripts: { total: 40, withSourceMap: 0 } }).measure(br, "/r/e2e", SAMPLE_DIFF);
  assert.equal(bundled.status, "unknown");
  assert.equal(bundled.measurement?.unmeasured, "no-source-maps");

  const mapped = await make({ covered: [], scripts: { total: 40, withSourceMap: 3 } }).measure(br, "/r/e2e", SAMPLE_DIFF);
  assert.equal(mapped.measurement?.unmeasured, "no-changed-file-mapped", "maps existed and still none reached a changed file");

  const none = await make({ covered: [], scripts: { total: 0, withSourceMap: 0 } }).measure(br, "/r/e2e", SAMPLE_DIFF);
  assert.equal(none.measurement?.unmeasured, "no-changed-file-mapped", "no script at all is not a statement about maps");
});

/* ── Per use case: a signal beside the aggregate, which stays the only figure that decides ── */

const CAND = (id: string, over: Record<string, unknown> = {}) => ({
  id, entry: { kind: "page" as const, repo: "org/app", route: `/${id}` }, tier: "direct" as const, basis: "graph" as const, evidence: [],
  seeds: [{ file: "src/checkout.ts", symbol: "s", range: { start: 1, end: 2 } }], confidence: 1, reachability: "page" as const, pages: [], existingSpecs: [], ...over,
});

function perCandidateAdapter(covered: number[]) {
  return new ObjectiveSignalPortAdapter(
    { collector: fakeCollector({ covered: [{ file: "src/checkout.ts", lines: covered }] }), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" }) },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
}

test("measure() with candidates reports each candidate's share and leaves the aggregate status, ratio and blocks as they are without them", async () => {
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const adapter = perCandidateAdapter([1]);
  const without = await adapter.measure(br, "/m/e2e", SAMPLE_DIFF);
  const withCandidates = await adapter.measure(br, "/m/e2e", SAMPLE_DIFF, undefined, { candidates: [CAND("uc-1")] });
  assert.equal(withCandidates.status, without.status);
  assert.equal(withCandidates.ratio, without.ratio);
  assert.equal(adapter.blocks(withCandidates.status), adapter.blocks(without.status));
  assert.equal(without.measurement?.perCandidate, undefined);
  assert.deepEqual(withCandidates.measurement?.perCandidate, [{ candidateId: "uc-1", changedLines: 2, coveredChanged: 1, ratio: 0.5 }]);
});

test("measure() with candidates and no source maps gives every candidate the reason, and the aggregate still never blocks", async () => {
  const adapter = new ObjectiveSignalPortAdapter(
    { collector: fakeCollector({ covered: [], scripts: { total: 3, withSourceMap: 0 } }), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" }) },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/m/e2e", SAMPLE_DIFF, undefined, { candidates: [CAND("uc-1"), CAND("uc-2")] });
  assert.equal(result.status, "unknown");
  assert.equal(adapter.blocks(result.status), false);
  assert.deepEqual(result.measurement?.perCandidate?.map((c) => c.unmeasured), ["no-source-maps", "no-source-maps"]);
});

test("measure() reports a diff that only deletes as deletion-only, and a withheld diff as cross-repo per candidate", async () => {
  const adapter = perCandidateAdapter([]);
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const deleting = "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1,2 +1,0 @@\n-a\n-b\n";
  const onlyDeleted = await adapter.measure(br, "/m/e2e", deleting);
  assert.equal(onlyDeleted.measurement?.unmeasured, "deletion-only");
  const withheld = await adapter.measure(br, "/m/e2e", undefined, undefined, { candidates: [CAND("uc-1")], crossRepo: true });
  assert.equal(withheld.measurement?.unmeasured, "no-diff");
  assert.equal(withheld.measurement?.perCandidate?.[0]?.unmeasured, "cross-repo");
});

test("measure() counts only the change's own code: the repo's test files a commit carries are neither collected nor counted", async () => {
  const diff = [
    SAMPLE_DIFF,
    "diff --git a/src/checkout.spec.ts b/src/checkout.spec.ts",
    "+++ b/src/checkout.spec.ts",
    "@@ -1,0 +1,3 @@",
    "+it('a', () => {});",
    "+it('b', () => {});",
    "+it('c', () => {});",
  ].join("\n");
  let collected: string[] | undefined;
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] }, (_dir, _ns, files) => { collected = files; });
  const oracle = fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide: new DecideCoverageService(), oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/mirrors/org/app/e2e", diff);

  assert.deepEqual(collected, ["src/checkout.ts"]);
  assert.equal(result.ratio, 1);
  assert.equal(result.status, "pass");
  assert.equal(result.measurement?.changedLines, 2);
  assert.equal(result.uncovered?.length, 0);
});

test("measure() of a commit that only changes the repo's tests has no changed lines to cover, which never blocks", async () => {
  const diff = ["diff --git a/src/checkout.spec.ts b/src/checkout.spec.ts", "+++ b/src/checkout.spec.ts", "@@ -1,0 +1,1 @@", "+it('a', () => {});"].join("\n");
  const adapter = new ObjectiveSignalPortAdapter(
    { collector: fakeCollector({ covered: [] }), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }) },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.spec.ts"]), "/mirrors/org/app/e2e", diff);

  assert.equal(result.status, "unknown");
  assert.equal(result.measurement?.unmeasured, "no-changed-lines");
  assert.equal(adapter.blocks(result.status), false);
});

test("measure() reports the branches on the changed lines and the arms that never ran beside the line ratio, which alone decides", async () => {
  const report: CoverageReport = {
    covered: [{ file: "src/checkout.ts", lines: [1, 2] }],
    branches: [{ file: "src/checkout.ts", line: 1, column: 0, kind: "if", arms: [{ label: "then", taken: true }, { label: "else", taken: false }] }],
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector: fakeCollector(report), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }) },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.equal(result.status, "pass");
  assert.equal(result.measurement?.changedBranches, 2);
  assert.equal(result.measurement?.takenBranches, 1);
  assert.deepEqual(result.untakenArms, [{ file: "src/checkout.ts", line: 1, kind: "if", arm: "else" }]);
});

test("measure() hands the mutants on the changed lines to the mutation oracle, with the spec files that reached them, and reports what it found", async () => {
  const site = (line: number) => ({ file: "src/checkout.ts", line, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", sourceLine: "if (x) pay();", ranIn: ["flows-pay-spec-ts-x-0-0.json"] });
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1, 2] }], mutationSites: [site(1), site(9)] };
  const asked: unknown[] = [];
  const mutation = {
    measure: async (mutants: Array<{ site: { line: number }; specFiles: string[] }>, specDir: string, namespace: string, baselineCases: string[]) => {
      asked.push({ lines: mutants.map((m) => m.site.line), specFiles: mutants.map((m) => m.specFiles), specDir, namespace, baselineCases });
      return { applied: 1, killed: 0, survived: [{ file: "src/checkout.ts", line: 1, operator: "negate condition" }] };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector: fakeCollector(report), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), mutation },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage, namespace: "run-7" },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/mirrors/org/app/e2e", SAMPLE_DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts", "flows/other.spec.ts"] });

  assert.deepEqual(asked, [{ lines: [1], specFiles: [["flows/pay.spec.ts"]], specDir: "/mirrors/org/app/e2e", namespace: "run-7", baselineCases: ["pays"] }]);
  assert.deepEqual(result.bundleMutation, { applied: 1, killed: 0, survived: [{ file: "src/checkout.ts", line: 1, operator: "negate condition" }] });
});

test("measure() with re-runs reads the latest dumps of every spec file, and its mutants are chosen from them", async () => {
  const site = (line: number, dump: string) => ({ file: "src/checkout.ts", line, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", sourceLine: "if (x) pay();", ranIn: [dump] });
  const sourcesAsked: unknown[] = [];
  let collected = 0;
  const collector: CoverageCollectorPort = {
    collect: async () => (collected++, { covered: [] }),
    recollect: async (_dir, sources) => {
      sourcesAsked.push(sources);
      return { covered: [{ file: "src/checkout.ts", lines: [1, 2] }], mutationSites: [site(1, "flows-pay-spec-ts-x-0-0.json"), site(2, "flows-other-spec-ts-y-0-0.json")] };
    },
  };
  const mutated: unknown[] = [];
  const mutation = {
    measure: async (mutants: Array<{ site: { line: number }; specFiles: string[] }>) => {
      mutated.push(mutants.map((m) => [m.site.line, m.specFiles]));
      return { applied: 2, killed: 2, survived: [] };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), mutation },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage, namespace: "run-7" },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/e2e", SAMPLE_DIFF, ["pays", "other"], {
    caseFiles: ["flows/pay.spec.ts", "flows/other.spec.ts"],
    reruns: [{ namespace: "run-7-r1", specFiles: ["flows/other.spec.ts"] }],
  });

  assert.equal(collected, 0, "no single namespace stands for the suite");
  assert.deepEqual(sourcesAsked, [[{ namespace: "run-7", exceptSpecFiles: ["flows/other.spec.ts"] }, { namespace: "run-7-r1", onlySpecFiles: ["flows/other.spec.ts"] }]]);
  assert.equal(result.ratio, 1);
  assert.deepEqual(mutated, [[[1, ["flows/pay.spec.ts"]], [2, ["flows/other.spec.ts"]]]], "the mutants are chosen from the dumps of both spec files");
});

test("measure() with re-runs whose dumps cannot all be read measures nothing: a part never stands for the suite", async () => {
  const adapter = new ObjectiveSignalPortAdapter(
    { collector: { collect: async () => ({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] }), recollect: async () => ({ covered: [{ file: "src/checkout.ts", lines: [1] }], incomplete: true }) }, decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }) },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage, namespace: "run-7" },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/e2e", SAMPLE_DIFF, [], { reruns: [{ namespace: "run-7-r1", specFiles: ["flows/other.spec.ts"] }] });

  assert.equal(result.status, "unknown");
  assert.equal(result.ratio, null);
});

test("measure() makes no mutant of a site whose source line in the working copy does not hold what it mutates, and records each site left out, by why, beside the outcome", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "qa-mutation-source-"));
  try {
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src/checkout.ts"), "if (x) pay();\nconst icon = theme === 'dark' ? 'moon' : 'sun';\n");
    const site = (line: number, expression: string) => ({ file: "src/checkout.ts", line, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: expression, expression, ranIn: ["flows-pay-spec-ts-x-0-0.json"] });
    const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1, 2] }], mutationSites: [site(1, "x"), site(2, "ngDevMode")] };
    const asked: Array<{ line: number; tests?: string[] }> = [];
    const mutation = {
      measure: async (mutants: Array<{ site: { line: number }; tests?: string[] }>) => {
        asked.push(...mutants.map((m) => ({ line: m.site.line, ...(m.tests ? { tests: m.tests } : {}) })));
        return { applied: 1, killed: 1, survived: [] };
      },
    };
    const adapter = new ObjectiveSignalPortAdapter(
      { collector: fakeCollector(report), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), mutation },
      { policy: { mode: "signal", minRatio: 0.7 }, repoDir, assembleChangeCoverage, namespace: "run-7" },
    );

    const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/e2e", SAMPLE_DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"] });

    assert.deepEqual(asked, [{ line: 1, tests: ["flows-pay-spec-ts-x"] }]);
    assert.deepEqual(result.bundleMutation?.skippedSites, { count: 1, reasons: { "not-in-source-line": 1 } });
    assert.equal(result.bundleMutation?.rerunsBySpecFile, undefined, "every mutant re-runs only the tests that reached it");
    assert.equal(result.mutantSelection?.rerunsByTest, 1);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("measure() hands back the survivors' mutants as they ran beside the outcome it records, which keeps no served script or edit", async () => {
  const site = { file: "src/checkout.ts", line: 1, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", sourceLine: "if (x) pay();", ranIn: ["flows-pay-spec-ts-x-0-0.json"] };
  const survivorRuns = [{ site, specFiles: ["flows/pay.spec.ts"] }];
  const mutation = { measure: async () => ({ applied: 1, killed: 0, survived: [{ file: "src/checkout.ts", line: 1, operator: "negate condition" }], survivorRuns }) };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector: fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }], mutationSites: [site] }), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), mutation },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage, namespace: "run-7" },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/e2e", SAMPLE_DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"] });

  assert.deepEqual(result.survivorRuns, survivorRuns);
  assert.equal(JSON.stringify(result.bundleMutation).includes("https://dev/main.js"), false, "the recorded outcome carries no served script");
});

test("recheckSurvivors() applies the survivors again through the mutation oracle under its namespace, and judges nothing without one", async () => {
  const site = { file: "src/checkout.ts", line: 1, column: 0, operator: "negate condition", script: { url: "u", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", ranIn: ["d"] };
  const asked: unknown[] = [];
  const judged = { applied: 1, killed: 1, survived: [] };
  const mutation = { measure: async (mutants: unknown, specDir: string, namespace: string, baselineCases: string[]) => (asked.push([mutants, specDir, namespace, baselineCases]), judged) };
  const build = (withMutation: boolean) => new ObjectiveSignalPortAdapter(
    { collector: fakeCollector({ covered: [] }), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), ...(withMutation ? { mutation } : {}) },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
  const survivors = [{ site, specFiles: ["flows/new.spec.ts"] }];

  assert.equal(await build(true).recheckSurvivors(survivors, "/e2e", "run-closure", ["pays"]), judged);
  assert.deepEqual(asked, [[survivors, "/e2e", "run-closure", ["pays"]]]);
  assert.equal(await build(false).recheckSurvivors(survivors, "/e2e", "run-closure", ["pays"]), null);
});

test("measure() asks the mutation oracle to observe and records what each survivor moved, which holds no served script; the re-check of survivors does not observe", async () => {
  const site = { file: "src/checkout.ts", line: 1, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", sourceLine: "if (x) pay();", ranIn: ["flows-pay-spec-ts-x-0-0.json"] };
  const moved = { kind: "moved" as const, requests: { added: ["GET https://api.example/styles/dark"], removed: [] }, dom: { added: [], removed: [] }, tests: ["flows/pay.spec.ts › pays"] };
  const options: unknown[] = [];
  const mutation = {
    measure: async (_mutants: unknown, _specDir: string, _namespace: string, _baselineCases: string[], opts?: unknown) => {
      options.push(opts);
      return { applied: 1, killed: 0, survived: [{ file: "src/checkout.ts", line: 1, operator: "negate condition", moved }] };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector: fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }], mutationSites: [site] }), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), mutation },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage, namespace: "run-7" },
  );

  const result = await adapter.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/e2e", SAMPLE_DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"] });
  await adapter.recheckSurvivors([{ site, specFiles: ["flows/new.spec.ts"] }], "/e2e", "run-closure", ["pays"]);

  assert.deepEqual(options, [{ observe: true }, undefined]);
  assert.deepEqual(result.bundleMutation?.survived[0]?.moved, moved);
  assert.equal(JSON.stringify(result.bundleMutation).includes("https://dev/main.js"), false);
});

test("measure() asks no mutation when no site is on a changed line, coverage measured nothing, or no mutation oracle is wired", async () => {
  let asked = 0;
  const mutation = { measure: async () => { asked++; return null; } };
  const site = { file: "src/checkout.ts", line: 40, column: 0, operator: "negate condition", script: { url: "u", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", ranIn: ["d"] };
  const build = (report: CoverageReport, withMutation = true) => new ObjectiveSignalPortAdapter(
    { collector: fakeCollector(report), decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), ...(withMutation ? { mutation } : {}) },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);

  const offChanged = await build({ covered: [{ file: "src/checkout.ts", lines: [1] }], mutationSites: [site] }).measure(br, "/e2e", SAMPLE_DIFF, ["t"]);
  const unmeasured = await build({ covered: [], mutationSites: [{ ...site, line: 1 }] }).measure(br, "/e2e", SAMPLE_DIFF, ["t"]);
  const unwired = await build({ covered: [{ file: "src/checkout.ts", lines: [1] }], mutationSites: [{ ...site, line: 1 }] }, false).measure(br, "/e2e", SAMPLE_DIFF, ["t"]);

  assert.equal(asked, 0);
  for (const r of [offChanged, unmeasured, unwired]) assert.equal("bundleMutation" in r, false);
});

test("recount() measures the change again over the dumps on disk: the first run's without those of the re-run spec files, plus each re-run's, with no oracle and no mutant", async () => {
  const asked: unknown[] = [];
  let oracleCalls = 0;
  const collector: CoverageCollectorPort = {
    collect: async () => ({ covered: [] }),
    recollect: async (specDir, sources) => {
      asked.push([specDir, sources]);
      return { covered: [{ file: "src/checkout.ts", lines: [1, 2] }], branches: [{ file: "src/checkout.ts", line: 2, column: 0, kind: "if", arms: [{ label: "then", taken: true }, { label: "else", taken: false }] }] };
    },
  };
  const oracle: ValueOraclePort = { measure: async () => { oracleCalls++; return { valueScore: 1, mutantCount: 1, killedCount: 1, details: "" }; } };
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide: new DecideCoverageService(), oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage });
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);

  const result = await adapter.recount!(br, "/e2e", SAMPLE_DIFF, [{ namespace: "run-acc0", specFiles: ["flows/a.spec.ts"] }, { namespace: "run-acc1", specFiles: ["flows/b.spec.ts"] }], { namespace: "run-ns" });

  assert.deepEqual(asked, [["/e2e", [{ namespace: "run-ns", exceptSpecFiles: ["flows/a.spec.ts", "flows/b.spec.ts"] }, { namespace: "run-acc0", onlySpecFiles: ["flows/a.spec.ts"] }, { namespace: "run-acc1", onlySpecFiles: ["flows/b.spec.ts"] }]]]);
  assert.equal(result?.status, "pass");
  assert.equal(result?.ratio, 1);
  assert.deepEqual(result?.uncovered, []);
  assert.deepEqual(result?.untakenArms, [{ file: "src/checkout.ts", line: 2, kind: "if", arm: "else" }]);
  assert.equal(result?.measurement?.changedBranches, 2);
  assert.equal(oracleCalls, 0, "a recount re-runs nothing");
});

test("recount() reads a spec re-run twice from its latest re-run only", async () => {
  const asked: unknown[] = [];
  const collector: CoverageCollectorPort = { collect: async () => ({ covered: [] }), recollect: async (_dir, sources) => (asked.push(sources), { covered: [{ file: "src/checkout.ts", lines: [1] }] }) };
  const oracle = fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide: new DecideCoverageService(), oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage });
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  await adapter.recount!(br, "/e2e", SAMPLE_DIFF, [{ namespace: "r-acc0", specFiles: ["a.spec.ts", "b.spec.ts"] }, { namespace: "r-acc1", specFiles: ["a.spec.ts"] }, { namespace: "r-acc2", specFiles: ["a.spec.ts"] }], { namespace: "r" });
  assert.deepEqual(asked, [[{ namespace: "r", exceptSpecFiles: ["a.spec.ts", "b.spec.ts"] }, { namespace: "r-acc0", onlySpecFiles: ["b.spec.ts"] }, { namespace: "r-acc2", onlySpecFiles: ["a.spec.ts"] }]]);
});

test("recount() reads a re-run's namespace for its own spec files only: a spec run there and given its prior bytes back never counts", async () => {
  const asked: unknown[] = [];
  const collector: CoverageCollectorPort = { collect: async () => ({ covered: [] }), recollect: async (_dir, sources) => (asked.push(sources), { covered: [{ file: "src/checkout.ts", lines: [1] }] }) };
  const oracle = fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide: new DecideCoverageService(), oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage });
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  /* The acceptance under r-acc0 ran a.spec.ts and b.spec.ts; only a.spec.ts was kept, so b.spec.ts is read from the first run. */
  await adapter.recount!(br, "/e2e", SAMPLE_DIFF, [{ namespace: "r-acc0", specFiles: ["a.spec.ts"] }], { namespace: "r" });
  assert.deepEqual(asked, [[{ namespace: "r", exceptSpecFiles: ["a.spec.ts"] }, { namespace: "r-acc0", onlySpecFiles: ["a.spec.ts"] }]]);
});

test("recount() has nothing to say with coverage off, without a diff, or with a collector that cannot add namespaces", async () => {
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const oracle = fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" });
  const recollecting: CoverageCollectorPort = { collect: async () => ({ covered: [] }), recollect: async () => ({ covered: [{ file: "src/checkout.ts", lines: [1] }] }) };
  const make = (collector: CoverageCollectorPort, mode: "off" | "signal") => new ObjectiveSignalPortAdapter({ collector, decide: new DecideCoverageService(), oracle }, { policy: { mode, minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage });
  const rerun = [{ namespace: "acc", specFiles: ["flows/a.spec.ts"] }];

  assert.equal(await make(recollecting, "off").recount!(br, "/e2e", SAMPLE_DIFF, rerun), null);
  assert.equal(await make(recollecting, "signal").recount!(br, "/e2e", undefined, rerun), null);
  assert.equal(await make(fakeCollector({ covered: [] }), "signal").recount!(br, "/e2e", SAMPLE_DIFF, rerun), null);
});

/* src/checkout.ts gains two code lines: line 1 ran in the passing tests, line 2 only under a killed mutant. */
const PROOF = { namespace: "run-7-mut0", specFiles: ["flows/pay.spec.ts"], url: "https://dev/main.js", sha256: "h", edit: { start: 0, end: 1, replacement: "!" }, original: "x" };

function provingAdapter(verified: CoverageReport, asked: unknown[] = []) {
  const first: CoverageReport = {
    covered: [{ file: "src/checkout.ts", lines: [1] }],
    branches: [{ file: "src/checkout.ts", line: 1, column: 0, kind: "if", arms: [{ label: "then", taken: false }, { label: "else", taken: true }] }],
    mutationSites: [{ file: "src/checkout.ts", line: 1, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", sourceLine: "if (x) pay();", ranIn: ["flows-pay-spec-ts-x-0-0.json"] }],
  };
  const collector: CoverageCollectorPort = {
    collect: async () => first,
    recollect: async (_specDir, sources) => {
      asked.push(sources);
      return verified;
    },
  };
  const mutation = { measure: async () => ({ applied: 1, killed: 1, survived: [], proofs: [PROOF] }) };
  return new ObjectiveSignalPortAdapter(
    { collector, decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }), mutation },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage, namespace: "run-7" },
  );
}

test("measure() counts what a killed mutant made run as covered, says how much the passing tests ran by themselves, and hands the proofs on", async () => {
  const asked: unknown[] = [];
  const verified: CoverageReport = {
    covered: [{ file: "src/checkout.ts", lines: [1, 2] }],
    branches: [{ file: "src/checkout.ts", line: 1, column: 0, kind: "if", arms: [{ label: "then", taken: true }, { label: "else", taken: true }] }],
  };

  const result = await provingAdapter(verified, asked).measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/e2e", SAMPLE_DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"] });

  assert.deepEqual(asked, [[{ namespace: "run-7" }, { namespace: "run-7-mut0", onlySpecFiles: ["flows/pay.spec.ts"], mutant: { url: "https://dev/main.js", sha256: "h", edit: { start: 0, end: 1, replacement: "!" }, original: "x" } }]]);
  assert.equal(result.status, "pass");
  assert.equal(result.ratio, 1);
  assert.deepEqual(result.uncovered, []);
  assert.deepEqual(result.untakenArms, [], "the arm the mutant forced is not asked for again");
  assert.equal(result.measurement?.coveredByExecution, 1);
  assert.equal(result.measurement?.provenByMutation, 1);
  assert.equal(result.measurement?.armsProvenByMutation, 1);
  assert.deepEqual(result.mutantProofs, [PROOF]);
  assert.deepEqual(result.bundleMutation, { applied: 1, killed: 1, survived: [] }, "the record keeps the counts, not the proofs");
});

test("measure() keeps the coverage by execution when the killed mutant's dumps cannot be read with the rest", async () => {
  const result = await provingAdapter({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }], incomplete: true }).measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), "/e2e", SAMPLE_DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"] });

  assert.equal(result.ratio, 0.5);
  assert.deepEqual(result.uncovered, [{ file: "src/checkout.ts", lines: [2] }]);
  assert.equal(result.measurement?.provenByMutation, undefined);
  assert.equal("mutantProofs" in result, false);
});

test("recount() adds the proofs of the spec files it did not re-run, and keeps the measurement before it when a source could not be read", async () => {
  const asked: unknown[] = [];
  const make = (report: CoverageReport) => new ObjectiveSignalPortAdapter(
    { collector: { collect: async () => ({ covered: [] }), recollect: async (_d, sources) => { asked.push(sources); return report; } }, decide: new DecideCoverageService(), oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }) },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage },
  );
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const stale = { ...PROOF, namespace: "run-7-mut1", specFiles: ["flows/rewritten.spec.ts"] };

  const counted = await make({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] }).recount!(br, "/e2e", SAMPLE_DIFF, [{ namespace: "run-acc0", specFiles: ["flows/rewritten.spec.ts"] }], { namespace: "run-7", proofs: [PROOF, stale] });
  const partial = await make({ covered: [{ file: "src/checkout.ts", lines: [1] }], incomplete: true }).recount!(br, "/e2e", SAMPLE_DIFF, [{ namespace: "run-acc0", specFiles: ["flows/rewritten.spec.ts"] }], { namespace: "run-7" });

  assert.deepEqual((asked[0] as Array<{ namespace: string }>).map((s) => s.namespace), ["run-7", "run-acc0", "run-7-mut0"], "a proof of a rewritten spec no longer holds");
  assert.equal(counted?.ratio, 1);
  assert.equal(partial, null);
});

/* ── changed files that are no gap of the suite ─────────────────────────────────────────────── */

const EXCLUDED_DIFF = [
  SAMPLE_DIFF,
  "diff --git a/src/preview.page.ts b/src/preview.page.ts",
  "+++ b/src/preview.page.ts",
  "@@ -0,0 +1,3 @@",
  "+if (native) open();",
  "+close();",
  "+done();",
  "diff --git a/src/store.spec-helper.ts b/src/store.spec-helper.ts",
  "+++ b/src/store.spec-helper.ts",
  "@@ -0,0 +1,2 @@",
  "+export const seed = 1;",
  "+export const reset = 2;",
].join("\n");

const EXCLUSIONS = {
  unreachableByDesign: [{ file: "src/preview.page.ts", routes: ["/upload-menu/preview"] }],
  testSupportFiles: [{ file: "src/store.spec-helper.ts", importers: 2 }],
};

function excludedRig(onCollect?: (files?: string[]) => void) {
  const report: CoverageReport = {
    covered: [{ file: "src/checkout.ts", lines: [1, 2] }],
    executable: [{ file: "src/checkout.ts", lines: [1, 2] }],
    branches: [{ file: "src/preview.page.ts", line: 1, column: 0, kind: "if", arms: [{ label: "then", taken: false }, { label: "else", taken: false }] }],
    mutationSites: [
      { file: "src/preview.page.ts", line: 1, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "native", sourceLine: "if (native) open();", ranIn: ["flows-a-spec-ts-x-0-0.json"] },
    ],
  };
  const mutated: number[] = [];
  const mutation = { measure: async (mutants: Array<{ site: { line: number } }>) => (mutated.push(mutants.length), { applied: mutants.length, killed: 0, survived: [] }) };
  const adapter = new ObjectiveSignalPortAdapter(
    {
      collector: { collect: async (_dir, _ns, files) => (onCollect?.(files), report), recollect: async (_dir, _sources, files) => (onCollect?.(files), report) },
      decide: new DecideCoverageService(),
      oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }),
      mutation,
    },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage },
  );
  return { adapter, mutated, br: BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]) };
}

test("measure() counts neither a file only reached through routes the change made unavailable nor test support, and records both apart with why", async () => {
  const collected: Array<string[] | undefined> = [];
  const { adapter, br, mutated } = excludedRig((files) => collected.push(files));

  const result = await adapter.measure(br, "/e2e", EXCLUDED_DIFF, ["pays"], { caseFiles: ["flows/a.spec.ts"], exclusions: EXCLUSIONS });

  assert.deepEqual(collected, [["src/checkout.ts"]], "nothing of the excluded files is collected");
  assert.equal(result.ratio, 1);
  assert.equal(result.status, "pass");
  assert.equal(result.measurement?.changedLines, 2);
  assert.equal(result.measurement?.changedBranches, undefined, "no decision of an excluded file is an arm to take");
  assert.equal(result.untakenArms, undefined);
  assert.deepEqual(result.uncovered, []);
  assert.equal(result.measurement?.notLoadedFiles, undefined);
  assert.deepEqual(result.measurement?.unreachableByDesign, EXCLUSIONS.unreachableByDesign);
  assert.deepEqual(result.measurement?.testSupportFiles, EXCLUSIONS.testSupportFiles);
  assert.deepEqual(mutated, [], "no mutant is made of an excluded file's site");
});

test("measure() without exclusions counts those files as before: not loaded, uncovered, with their arms and mutants", async () => {
  const { adapter, br, mutated } = excludedRig();

  const result = await adapter.measure(br, "/e2e", EXCLUDED_DIFF, ["pays"], { caseFiles: ["flows/a.spec.ts"] });

  assert.equal(result.ratio, 2 / 7);
  assert.deepEqual(result.measurement?.notLoadedFiles, ["src/preview.page.ts", "src/store.spec-helper.ts"]);
  assert.equal(result.measurement?.changedBranches, 2);
  assert.equal(result.measurement?.unreachableByDesign, undefined);
  assert.equal(result.measurement?.testSupportFiles, undefined);
  assert.deepEqual(mutated, [1]);
});

test("recount() leaves the same files out and records them", async () => {
  const collected: Array<string[] | undefined> = [];
  const { adapter, br } = excludedRig((files) => collected.push(files));

  const result = await adapter.recount!(br, "/e2e", EXCLUDED_DIFF, [{ namespace: "run-acc0", specFiles: ["flows/a.spec.ts"] }], { exclusions: EXCLUSIONS });

  assert.deepEqual(collected, [["src/checkout.ts"]]);
  assert.equal(result?.ratio, 1);
  assert.deepEqual(result?.untakenArms, []);
  assert.deepEqual(result?.measurement.unreachableByDesign, EXCLUSIONS.unreachableByDesign);
  assert.deepEqual(result?.measurement.testSupportFiles, EXCLUSIONS.testSupportFiles);
});

test("measure() whose every changed file is excluded has no changed lines and never blocks", async () => {
  const onlyExcluded = EXCLUDED_DIFF.slice(EXCLUDED_DIFF.indexOf("diff --git a/src/preview.page.ts"));
  const { adapter, br } = excludedRig();

  const result = await adapter.measure(br, "/e2e", onlyExcluded, [], { exclusions: EXCLUSIONS });

  assert.equal(result.status, "unknown");
  assert.equal(result.measurement?.unmeasured, "no-changed-lines");
  assert.equal(adapter.blocks(result.status), false);
});

/* ── changed files no loaded script maps, read by their language's statement syntax ─────────── */

const UNLOADED_DIFF = [
  SAMPLE_DIFF,
  "diff --git a/src/shared/index.ts b/src/shared/index.ts",
  "+++ b/src/shared/index.ts",
  "@@ -1,0 +2 @@",
  "+export * from './flip';",
  "diff --git a/src/lazy.ts b/src/lazy.ts",
  "+++ b/src/lazy.ts",
  "@@ -0,0 +1,2 @@",
  "+import { x } from './x';",
  "+go(x);",
  "diff --git a/src/Main.java b/src/Main.java",
  "+++ b/src/Main.java",
  "@@ -0,0 +1 @@",
  "+import a.B;",
].join("\n");

const UNLOADED_SOURCES: Record<string, string> = {
  "src/shared/index.ts": "export * from './card';\nexport * from './flip';\n",
  "src/lazy.ts": "import { x } from './x';\ngo(x);\n",
  "src/Main.java": "import a.B;\n",
};

function unloadedRig(sources: Record<string, string> = UNLOADED_SOURCES) {
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1, 2] }], executable: [{ file: "src/checkout.ts", lines: [1, 2] }] };
  const adapter = new ObjectiveSignalPortAdapter(
    {
      collector: { collect: async () => report, recollect: async () => report },
      decide: new DecideCoverageService(),
      oracle: fakeOracle({ valueScore: null, mutantCount: null, killedCount: null, details: "" }),
      readSource: (file) => sources[file],
    },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage },
  );
  return { adapter, br: BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]) };
}

test("measure() leaves out a changed file no loaded script maps whose changed lines are all imports, re-exports or types, recorded apart; a file with code counts only its code lines", async () => {
  const { adapter, br } = unloadedRig();

  const result = await adapter.measure(br, "/e2e", UNLOADED_DIFF, ["pays"]);

  assert.deepEqual(result.measurement?.noCodeFiles, ["src/shared/index.ts"]);
  assert.deepEqual(result.measurement?.notLoadedFiles, ["src/lazy.ts", "src/Main.java"], "the Java file, whose language declares no statement syntax, counts as before");
  assert.deepEqual(result.uncovered, [{ file: "src/lazy.ts", lines: [2] }, { file: "src/Main.java", lines: [1] }]);
  assert.equal(result.measurement?.changedLines, 4, "checkout.ts 1-2, lazy.ts 2, Main.java 1");
  assert.equal(result.measurement?.notExecutableLines, 2, "the re-export and the import");
});

test("recount() reads the unloaded files the same way", async () => {
  const { adapter, br } = unloadedRig();

  const result = await adapter.recount!(br, "/e2e", UNLOADED_DIFF, [{ namespace: "run-acc0", specFiles: ["flows/a.spec.ts"] }]);

  assert.deepEqual(result?.measurement.noCodeFiles, ["src/shared/index.ts"]);
  assert.deepEqual(result?.uncovered, [{ file: "src/lazy.ts", lines: [2] }, { file: "src/Main.java", lines: [1] }]);
});

test("measure() whose source of an unloaded file cannot be read counts its non-blank lines, as before", async () => {
  const { adapter, br } = unloadedRig({});

  const result = await adapter.measure(br, "/e2e", UNLOADED_DIFF, ["pays"]);

  assert.equal(result.measurement?.noCodeFiles, undefined);
  assert.deepEqual(result.measurement?.notLoadedFiles, ["src/shared/index.ts", "src/lazy.ts", "src/Main.java"]);
});

test("measure() of a change whose every added line is no code has no changed lines, which is not a deletion and never blocks", async () => {
  const { adapter, br } = unloadedRig();
  const onlyReexport = UNLOADED_DIFF.slice(UNLOADED_DIFF.indexOf("diff --git a/src/shared/index.ts"), UNLOADED_DIFF.indexOf("diff --git a/src/lazy.ts"));

  const result = await adapter.measure(br, "/e2e", onlyReexport, []);

  assert.equal(result.status, "unknown");
  assert.equal(result.measurement?.unmeasured, "no-changed-lines");
  assert.deepEqual(result.measurement?.noCodeFiles, ["src/shared/index.ts"]);
});
