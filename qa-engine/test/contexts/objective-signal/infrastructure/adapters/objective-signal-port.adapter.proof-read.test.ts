/* A killed mutant's re-run whose dumps cannot be decoded, through the collector the engine runs (its reader, the executor faked at the process boundary): the measurement by execution stands and says the evidence it stands without. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectiveSignalPortAdapter } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import { V8BrowserCoverageAdapter } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";
import { readV8Coverage } from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import type { CoverageRead } from "@contexts/objective-signal/domain/coverage-collector.ts";
import type { OffLoopExecutor } from "../../../../../src/shared-infrastructure/worker/off-loop-executor.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const CHANGED = "src/checkout.ts";
const DIFF = ["diff --git a/src/checkout.ts b/src/checkout.ts", "+++ b/src/checkout.ts", "@@ -1,0 +1,2 @@", "+a", "+b"].join("\n");
const br = BlastRadius.of(Sha.of("abc1234"), [CHANGED]);
const DUMP = "flows-pay-spec-ts-pays-0-0.json";
const SITE = { file: CHANGED, line: 1, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", sourceLine: "if (x) pay();", ranIn: [DUMP] };
const PROOF = { namespace: "run-7-mut0", specFiles: ["flows/pay.spec.ts"], url: "https://dev/main.js", sha256: "h", edit: { start: 0, end: 1, replacement: "!" }, original: "x" };

function e2eWith(t: TestContext, namespaces: string[]): string {
  const e2e = mkdtempSync(join(tmpdir(), "qa-proof-read-"));
  t.after(() => rmSync(e2e, { recursive: true, force: true }));
  for (const ns of namespaces) {
    const dir = join(e2e, ".qa", "coverage", ns);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DUMP), `dump of ${ns}`);
  }
  return e2e;
}

const decoded = (lines: number[]): Buffer => Buffer.from(JSON.stringify({ refused: false, covered: [[CHANGED, lines]], executable: [[CHANGED, [1, 2]]], scripts: { total: 1, withSourceMap: 1 }, branches: [] }));

/* Decodes every read, a mutant's re-run (the read carrying the edit) excepted when `mutantEnds` says how it ends. */
function executor(mutantEnds?: "aborted" | "heap-limit" | "crashed" | "unavailable"): OffLoopExecutor {
  return {
    run: async (inputs, _signal, context) => {
      const isMutant = ((context ?? {}) as { mutant?: unknown }).mutant !== undefined;
      if (isMutant && mutantEnds) return { kind: "failed", reason: mutantEnds };
      return { kind: "done", outputs: inputs.map(() => decoded(isMutant ? [2] : [1])) };
    },
  };
}

function adapter(exec: OffLoopExecutor) {
  const real = new V8BrowserCoverageAdapter((specDir, ns, changed, scripts, branches, keep, executable, mutant, ranBy, reads) => readV8Coverage(specDir, ns, changed, undefined, exec, 5_000, scripts, branches, keep, executable, mutant, ranBy, reads), [CHANGED]);
  const collector = { collect: async (d: string, ns: string, ch?: string[]) => ({ ...(await real.collect(d, ns, ch)), mutationSites: [SITE] as never }), recollect: (d: string, src: never, ch?: string[]) => real.recollect(d, src, ch) };
  const mutation = { measure: async () => ({ applied: 1, killed: 1, survived: [], proofs: [PROOF] }) };
  return new ObjectiveSignalPortAdapter({ collector, decide: new DecideCoverageService(), mutation: mutation as never }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage, namespace: "run-7" });
}

for (const reason of ["aborted", "heap-limit", "crashed", "unavailable"] as const) {
  test(`a killed mutant's re-run whose decode ends ${reason}: the measurement by execution stands and says the evidence it stands without`, async (t) => {
    const e2e = e2eWith(t, ["run-7", "run-7-mut0"]);
    const told: CoverageRead[] = [];

    const result = await adapter(executor(reason)).measure(br, e2e, DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"], onRead: (r) => told.push(r) });

    assert.equal(result.ratio, 0.5, "the lines the passing tests ran stand");
    assert.equal(result.measurement?.unmeasured, undefined);
    assert.deepEqual(result.measurement?.evidenceLeftOut, [`decode-${reason}`]);
    assert.equal(result.mutantProofs, undefined, "no proof stands for evidence that was not read");
    assert.deepEqual(told.filter((r) => r.namespace === "run-7-mut0").map((r) => r.outcome), [reason], "and the read that failed is told");
  });
}

test("a killed mutant's re-run that decodes adds what the mutant made run, and leaves nothing out", async (t) => {
  const e2e = e2eWith(t, ["run-7", "run-7-mut0"]);

  const result = await adapter(executor()).measure(br, e2e, DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"] });

  assert.equal(result.ratio, 1);
  assert.equal(result.measurement?.evidenceLeftOut, undefined);
});
