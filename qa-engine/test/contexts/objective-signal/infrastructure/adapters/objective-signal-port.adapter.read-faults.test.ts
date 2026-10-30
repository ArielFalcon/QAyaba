/* A measurement whose evidence could not be read says so, with the reason the read ended for, and never as a change no executed source mapped to. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectiveSignalPortAdapter } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import type { CoverageCollectorPort } from "@contexts/objective-signal/application/ports/coverage-collector.port.ts";
import type { CoverageRead, CoverageReport } from "@contexts/objective-signal/domain/coverage-collector.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const DIFF = ["diff --git a/src/checkout.ts b/src/checkout.ts", "+++ b/src/checkout.ts", "@@ -1,0 +1,2 @@", "+a", "+b"].join("\n");
const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
const read = (outcome: CoverageRead["outcome"], namespace = "run-7"): CoverageRead => ({ namespace, startedAt: 1_000, durationMs: 12, dumps: 3, bytes: 300, outcome, startMs: 2, workMs: 9 });

function adapter(collector: CoverageCollectorPort, mutation?: ConstructorParameters<typeof ObjectiveSignalPortAdapter>[0]["mutation"]) {
  return new ObjectiveSignalPortAdapter({ collector, decide: new DecideCoverageService(), ...(mutation ? { mutation } : {}) }, { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/r", assembleChangeCoverage, namespace: "run-7" });
}

test("a read that was stopped at its deadline is the reason the measurement decides nothing, not a change nothing mapped to", async () => {
  const report: CoverageReport = { covered: [], reads: [read("aborted")], fault: "decode-aborted" };
  const told: CoverageRead[] = [];

  const result = await adapter({ collect: async () => report }).measure(br, "/r/e2e", DIFF, [], { onRead: (r) => told.push(r) });

  assert.equal(result.status, "unknown");
  assert.equal(result.measurement?.unmeasured, "decode-aborted");
  assert.deepEqual(told, report.reads, "and the read is told to the observer");
});

for (const fault of ["decode-heap-limit", "decode-crashed", "decode-unavailable", "dumps-over-cap", "dumps-unusable"] as const) {
  test(`${fault} is its own reason`, async () => {
    const result = await adapter({ collect: async () => ({ covered: [], reads: [read("unusable")], fault }) }).measure(br, "/r/e2e", DIFF);
    assert.equal(result.measurement?.unmeasured, fault);
  });
}

test("when the latest dumps of several executions are read and one of the reads ends badly, the reason is that read's, not the assembler's absence", async () => {
  const collector: CoverageCollectorPort = {
    collect: async () => ({ covered: [] }),
    recollect: async () => ({ covered: [{ file: "src/checkout.ts", lines: [1] }], incomplete: true, reads: [read("completed"), read("aborted", "run-acc0")], fault: "decode-aborted" }),
  };

  const result = await adapter(collector).measure(br, "/r/e2e", DIFF, [], { reruns: [{ namespace: "run-acc0", specFiles: ["flows/pay.spec.ts"] }] });

  assert.equal(result.status, "unknown");
  assert.equal(result.measurement?.unmeasured, "decode-aborted");
});

test("a run that left no dump is told as no dumps; a read that completed over dumps no changed file maps to stays no changed file mapped", async () => {
  const none = await adapter({ collect: async () => ({ covered: [], reads: [read("absent")] }) }).measure(br, "/r/e2e", DIFF);
  assert.equal(none.measurement?.unmeasured, "no-dumps");

  const mapped = await adapter({ collect: async () => ({ covered: [], scripts: { total: 4, withSourceMap: 2 }, reads: [read("completed")] }) }).measure(br, "/r/e2e", DIFF);
  assert.equal(mapped.measurement?.unmeasured, "no-changed-file-mapped");
});

test("a measurement that stands without the evidence of a killed mutant's re-run says that evidence was left out, and why", async () => {
  const PROOF = { namespace: "run-7-mut0", specFiles: ["flows/pay.spec.ts"], url: "https://dev/main.js", sha256: "h", edit: { start: 0, end: 1, replacement: "!" }, original: "x" };
  const first: CoverageReport = {
    covered: [{ file: "src/checkout.ts", lines: [1] }],
    reads: [read("completed")],
    mutationSites: [{ file: "src/checkout.ts", line: 1, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 0, end: 1, replacement: "!" }, original: "x", sourceLine: "if (x) pay();", ranIn: ["flows-pay-spec-ts-x-0-0.json"] }],
  };
  const collector: CoverageCollectorPort = {
    collect: async () => first,
    recollect: async () => ({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }], incomplete: true, reads: [read("completed"), read("aborted", "run-7-mut0")], fault: "decode-aborted" }),
  };
  const mutation = { measure: async () => ({ applied: 1, killed: 1, survived: [], proofs: [PROOF] }) };
  const told: CoverageRead[] = [];

  const result = await adapter(collector, mutation).measure(br, "/r/e2e", DIFF, ["pays"], { caseFiles: ["flows/pay.spec.ts"], onRead: (r) => told.push(r) });

  assert.equal(result.ratio, 0.5, "the measurement by execution stands");
  assert.equal(result.measurement?.unmeasured, undefined);
  assert.deepEqual(result.measurement?.evidenceLeftOut, ["decode-aborted"]);
  assert.deepEqual(told.map((r) => [r.namespace, r.outcome]), [["run-7", "completed"], ["run-7", "completed"], ["run-7-mut0", "aborted"]], "every read that cost time is told, the proof pass's too");
});

test("recount() tells its reads, and says nothing else when a source could not be read: the measurement before it stands", async () => {
  const told: CoverageRead[] = [];
  const collector: CoverageCollectorPort = { collect: async () => ({ covered: [] }), recollect: async () => ({ covered: [], incomplete: true, reads: [read("aborted")], fault: "decode-aborted" }) };

  const counted = await adapter(collector).recount!(br, "/r/e2e", DIFF, [{ namespace: "run-acc0", specFiles: ["flows/pay.spec.ts"] }], { onRead: (r) => told.push(r) });

  assert.equal(counted, null);
  assert.deepEqual(told.map((r) => r.outcome), ["aborted"]);
});
