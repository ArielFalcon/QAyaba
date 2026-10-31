/* The mutation pass is held to the time the run's coverage purpose has left: a re-run (the observation before, each mutant, the observation after) starts only when that time holds its estimate, the measured duration of the cases it would execute in the run's own final execution. What it leaves out is said, and why. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts";
import { RERUN_LEFT_OUT_FOR_TIME } from "@contexts/objective-signal/domain/rerun-budget.ts";
import type { MutantRun } from "@contexts/objective-signal/domain/coverage-collector.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const SPEC = "flows/cart.spec.ts";
const TEST = `${SPEC} › adds an item`;
const TEST_MS = 60_000;

const mutant = (line: number): MutantRun => ({
  site: {
    file: "src/cart.ts",
    line,
    column: 4,
    operator: "negate condition",
    script: { url: "https://dev.example/main.js", sha256: "abc" },
    edit: { start: 10, end: 20, replacement: "!(n > 0)" },
    original: "n > 0",
    ranIn: ["flows-cart-spec-ts-adds-an-item-0-0.json"],
  },
  specFiles: [SPEC],
});

/* The run's final execution: the one test of the spec file, with the time it took. */
const finalCases: QaCase[] = [{ name: TEST, status: "pass", file: SPEC, durationMs: TEST_MS }];

/* A re-run takes the time its test took in the final execution, on the clock `now` reads; the coverage purpose's allowance is what is left of `allowanceMs` after the re-runs so far. */
function timedRuns(allowanceMs: number) {
  const namespaces: string[] = [];
  let spent = 0;
  return {
    namespaces,
    now: () => spent,
    allowance: () => allowanceMs - spent,
    run: async ({ namespace }: { namespace: string }) => {
      namespaces.push(namespace);
      spent += TEST_MS;
      return { verdict: "pass", cases: [{ name: TEST, status: "pass" as const, file: SPEC }], observations: [{ name: TEST, requests: [], dom: ["heading: Cart"] }] };
    },
  };
}

test("with time for only part of the pass, the oracle starts no re-run the coverage allowance cannot hold and says how many it left out and why", async () => {
  const timed = timedRuns(2 * TEST_MS + TEST_MS / 2);
  const oracle = new BundleMutationOracleAdapter(timed.run, () => 1, "https://dev.example", timed.now);

  const result = await oracle.measure([mutant(10), mutant(12)], "/e2e", "run-1", [TEST], { observe: true, budget: { allowance: timed.allowance, cases: finalCases } });

  assert.deepEqual(timed.namespaces, ["run-1-obs", "run-1-mut0"], "the second mutant and the observation after it would not fit what was left");
  assert.deepEqual(result?.leftOut, { mutants: 1, observations: 1, reason: RERUN_LEFT_OUT_FOR_TIME }, "the mutants left out unjudged are counted apart from the observations");
  assert.equal(result?.applied, 1, "a mutant left out is neither applied nor judged");
  assert.equal(result?.survived.length, 1);
  assert.equal(result?.survived[0]?.moved?.kind, "unobserved", "without the observation after, the survivor's moves are not told");
});

test("with no time for any re-run, no mutant is applied and the result still says what was left out", async () => {
  const timed = timedRuns(TEST_MS / 2);
  const oracle = new BundleMutationOracleAdapter(timed.run, () => 1, "https://dev.example", timed.now);

  const result = await oracle.measure([mutant(10)], "/e2e", "run-1", [TEST], { observe: true, budget: { allowance: timed.allowance, cases: finalCases } });

  assert.deepEqual(timed.namespaces, []);
  assert.equal(result?.applied, 0);
  assert.deepEqual(result?.leftOut, { mutants: 1, observations: 1, reason: RERUN_LEFT_OUT_FOR_TIME }, "the observation before and the mutant; with no observation before, none is made after");
});

test("with ample time the pass measures and judges every mutant exactly as it does with no allowance to hold it to", async () => {
  const held = timedRuns(100 * TEST_MS);
  const free = timedRuns(0);

  const withTime = await new BundleMutationOracleAdapter(held.run, () => 1, "https://dev.example", held.now).measure([mutant(10), mutant(12)], "/e2e", "run-1", [TEST], { observe: true, budget: { allowance: held.allowance, cases: finalCases } });
  const unbounded = await new BundleMutationOracleAdapter(free.run, () => 1, "https://dev.example", free.now).measure([mutant(10), mutant(12)], "/e2e", "run-1", [TEST], { observe: true });

  assert.deepEqual(held.namespaces, ["run-1-obs", "run-1-mut0", "run-1-mut1", "run-1-obs2"]);
  assert.deepEqual(held.namespaces, free.namespaces);
  assert.deepEqual(withTime, unbounded);
  assert.equal(withTime?.leftOut, undefined);
});

test("once a re-run of the pass has run, the next ones are estimated from what it took against its cases' time in the final execution", async () => {
  /* Each re-run takes three times what its test took in the final execution: start-up, instrumentation and observation. */
  let clock = 0;
  const namespaces: string[] = [];
  const allowanceMs = 500_000;
  const run = async ({ namespace }: { namespace: string }) => {
    namespaces.push(namespace);
    clock += 3 * TEST_MS;
    return { verdict: "pass", cases: [{ name: TEST, status: "pass" as const, file: SPEC }], observations: [{ name: TEST, requests: [], dom: ["heading: Cart"] }] };
  };
  const oracle = new BundleMutationOracleAdapter(run, () => 1, "https://dev.example", () => clock);

  const result = await oracle.measure([mutant(10), mutant(12)], "/e2e", "run-1", [TEST], { observe: true, budget: { allowance: () => allowanceMs - clock, cases: finalCases } });

  assert.deepEqual(namespaces, ["run-1-obs", "run-1-mut0"], "after the observation took 180 s, a 60 s test is estimated at 180 s, which the 140 s left cannot hold");
  assert.deepEqual(result?.leftOut, { mutants: 1, observations: 1, reason: RERUN_LEFT_OUT_FOR_TIME });
});

test("a re-run that could not run its tests says nothing of what a re-run costs: the next is estimated as before it", async () => {
  /* The first mutant's re-run fails to start at once; the time left then drops below one test's time. */
  const left = [100_000, 30_000];
  const namespaces: string[] = [];
  const run = async ({ namespace }: { namespace: string }) => {
    namespaces.push(namespace);
    return namespace.endsWith("-mut0") ? { verdict: "infra-error", cases: [] } : { verdict: "pass", cases: [{ name: TEST, status: "pass" as const, file: SPEC }] };
  };
  const oracle = new BundleMutationOracleAdapter(run, () => 1, "https://dev.example", () => 0);

  const result = await oracle.measure([mutant(10), mutant(12)], "/e2e", "run-1", [TEST], { budget: { allowance: () => left.shift() ?? 0, cases: finalCases } });

  assert.deepEqual(namespaces, ["run-1-mut0"], "the second mutant is still estimated at its test's 60 s, which 30 s cannot hold");
  assert.deepEqual(result?.leftOut, { mutants: 1, observations: 0, reason: RERUN_LEFT_OUT_FOR_TIME });
});
