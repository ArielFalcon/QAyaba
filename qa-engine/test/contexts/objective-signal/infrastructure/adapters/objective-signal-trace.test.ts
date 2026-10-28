/* The coverage span says how many use cases were asked about, how many got a ratio and, per reason, how many did not. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TracedObjectiveSignalPort } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-trace.ts";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/ports/objective-signal.port.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle } from "@kernel/telemetry/telemetry.port.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

class Recorder extends NoopTelemetry {
  readonly attrs: Array<Record<string, unknown>> = [];
  override startSpan(name?: string, opts?: Parameters<NoopTelemetry["startSpan"]>[1]): SpanHandle {
    const inner = super.startSpan(name, opts);
    return { ...inner, setAttrs: (attrs) => { this.attrs.push({ ...attrs }); inner.setAttrs(attrs); }, addEvent: (...a) => inner.addEvent(...a), recordError: (...a) => inner.recordError(...a), end: (...a) => inner.end(...a), context: () => inner.context() };
  }
}

test("the coverage span counts candidates, those measured and those unmeasured per reason", async () => {
  const inner: ObjectiveSignalPort = {
    measure: async () => ({
      status: "unknown", ratio: null,
      measurement: {
        changedLines: 4, coveredChanged: 0, changedFiles: 1, mappedFiles: 0, unmeasured: "no-source-maps",
        perCandidate: [
          { candidateId: "uc-1", changedLines: 2, coveredChanged: 0, ratio: null, unmeasured: "no-source-maps" },
          { candidateId: "uc-2", changedLines: 2, coveredChanged: 0, ratio: null, unmeasured: "no-source-maps" },
          { candidateId: "uc-3", changedLines: 0, coveredChanged: 0, ratio: null, unmeasured: "backend" },
          { candidateId: "uc-4", changedLines: 2, coveredChanged: 2, ratio: 1 },
        ],
      },
    }),
    blocks: () => false,
  };
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(inner, telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e");
  const attrs = telemetry.attrs.find((a) => "qayaba.coverage.candidates" in a)!;
  assert.equal(attrs["qayaba.coverage.candidates"], 4);
  assert.equal(attrs["qayaba.coverage.candidates_measured"], 1);
  assert.deepEqual(attrs["qayaba.coverage.candidates_unmeasured"], ["no-source-maps: 2", "backend: 1"]);
});

test("a measurement without candidates adds no candidate attribute", async () => {
  const inner: ObjectiveSignalPort = { measure: async () => ({ status: "pass", ratio: 1, measurement: { changedLines: 1, coveredChanged: 1, changedFiles: 1, mappedFiles: 1 } }), blocks: () => false };
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(inner, telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e");
  assert.ok(!telemetry.attrs.some((a) => "qayaba.coverage.candidates" in a));
});

test("the coverage span names the unloaded changed files left out because none of their changed lines is code, and adds nothing when there are none", async () => {
  const measured = (noCodeFiles?: string[]): ObjectiveSignalPort => ({
    measure: async () => ({ status: "pass", ratio: 1, measurement: { changedLines: 1, coveredChanged: 1, changedFiles: 1, mappedFiles: 1, ...(noCodeFiles ? { noCodeFiles } : {}) } }),
    blocks: () => false,
  });
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(measured(["src/shared/index.ts"]), telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e");
  assert.deepEqual(telemetry.attrs.find((a) => "qayaba.coverage.changed_lines" in a)?.["qayaba.coverage.no_code_files"], ["src/shared/index.ts"]);

  const none = new Recorder();
  await new TracedObjectiveSignalPort(measured(), none).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e");
  assert.ok(!none.attrs.some((a) => "qayaba.coverage.no_code_files" in a));
});

test("the coverage span counts the surviving mutants a spec reached and those none did", async () => {
  const survived = [
    { file: "src/a.ts", line: 1, operator: "swap", specFiles: ["flows/a.spec.ts"] },
    { file: "src/a.ts", line: 2, operator: "swap", specFiles: [] },
    { file: "src/a.ts", line: 3, operator: "swap" },
  ];
  const inner: ObjectiveSignalPort = { measure: async () => ({ status: "pass", ratio: 1, bundleMutation: { applied: 4, killed: 1, survived } }), blocks: () => false };
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(inner, telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e");
  const attrs = telemetry.attrs.find((a) => "qayaba.mutation.applied" in a)!;
  assert.equal(attrs["qayaba.mutation.survivors_routed"], 1);
  assert.equal(attrs["qayaba.mutation.survivors_without_spec"], 2);
});

test("the coverage span counts the survivors whose mutation moved an observable, those it moved none of and those whose runs were not compared; a pass that observed none states none", async () => {
  const moved = { kind: "moved" as const, requests: { added: ["GET https://api.example/styles/dark"], removed: [] }, dom: { added: [], removed: [] }, tests: ["a.spec.ts › t"] };
  const survived = [
    { file: "src/a.ts", line: 1, operator: "swap", moved },
    { file: "src/a.ts", line: 2, operator: "swap", moved: { kind: "unmoved" as const, tests: 1 } },
    { file: "src/a.ts", line: 3, operator: "swap", moved: { kind: "unobserved" as const, reason: "baseline" as const } },
    { file: "src/a.ts", line: 4, operator: "swap", moved },
  ];
  const measureWith = async (list: typeof survived | Array<{ file: string; line: number; operator: string }>) => {
    const inner: ObjectiveSignalPort = { measure: async () => ({ status: "pass", ratio: 1, bundleMutation: { applied: 4, killed: 0, survived: list } }), blocks: () => false };
    const telemetry = new Recorder();
    await new TracedObjectiveSignalPort(inner, telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e");
    return telemetry.attrs.find((a) => "qayaba.mutation.applied" in a)!;
  };

  const attrs = await measureWith(survived);
  assert.equal(attrs["qayaba.mutation.survivors_moved"], 2);
  assert.equal(attrs["qayaba.mutation.survivors_unmoved"], 1);
  assert.equal(attrs["qayaba.mutation.survivors_unobserved"], 1);
  assert.equal(attrs["qayaba.mutation.survivors_routed"] !== undefined, true, "the counts that were there stay");

  const unasked = await measureWith([{ file: "src/a.ts", line: 1, operator: "swap" }]);
  assert.equal("qayaba.mutation.survivors_moved" in unasked, false);
});

test("the coverage span counts the mutation sites left out per reason and how each mutant's re-run was scoped, even when no mutant was judged", async () => {
  const mutantSelection = { skippedSites: { count: 3, reasons: { "not-in-source-line": 2, "no-source-line": 1 } }, rerunsByTest: 0, rerunsBySpecFile: 0 };
  const inner: ObjectiveSignalPort = { measure: async () => ({ status: "pass", ratio: 1, mutantSelection }), blocks: () => false };
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(inner, telemetry).measure(BlastRadius.of(Sha.of("abc1234"), []), "/e2e");
  const attrs = telemetry.attrs.find((a) => "qayaba.mutation.sites_skipped" in a)!;
  assert.equal(attrs["qayaba.mutation.sites_skipped"], 3);
  assert.deepEqual(attrs["qayaba.mutation.sites_skipped_reasons"], ["not-in-source-line: 2", "no-source-line: 1"]);
  assert.equal(attrs["qayaba.mutation.reruns_by_test"], 0);
  assert.equal(attrs["qayaba.mutation.reruns_by_spec_file"], 0);
});
