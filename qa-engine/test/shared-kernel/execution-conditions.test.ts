/* An execution's conditions as one value: two judging executions that differ only in what the contract records (namespace, spec set, retries, timeout) share a digest; one that adds instrumentation does not, and says what it adds. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contractDigest, deviationsOf, executionConditions, kindOfPurpose, recordOfExecution, type ExecutionConditionsInput } from "@kernel/execution-conditions.ts";

const NONE = { coverage: false, observe: false, route: false, writeCounter: false };
const GEO = { latitude: 40.4818, longitude: -3.3643 };

const of = (over: Partial<ExecutionConditionsInput>) => executionConditions({ purpose: "suite", instrumentation: NONE, processTimeoutMs: 900_000, namespace: "run-1", startedAt: 1_000_000, geolocation: GEO, ...over });

test("two judging executions that differ only in namespace, spec set, retries and timeout ran under one contract", () => {
  const final = of({});
  const acceptance = of({ purpose: "acceptance", namespace: "run-1-acc0", specFiles: ["flows/a.spec.ts"], retries: 0, processTimeoutMs: 60_000 });
  assert.equal(contractDigest(final), contractDigest(acceptance));
  assert.deepEqual(deviationsOf(final), []);
  assert.deepEqual(deviationsOf(acceptance), []);
});

test("an execution that adds instrumentation runs under another digest and names each condition it adds", () => {
  const plain = of({});
  const instrumented = of({ instrumentation: { coverage: true, observe: true, route: true, writeCounter: false } });
  const counted = of({ purpose: "run-spec", instrumentation: { ...NONE, writeCounter: true } });
  assert.notEqual(contractDigest(plain), contractDigest(instrumented));
  assert.deepEqual(deviationsOf(instrumented), ["coverage", "observation", "route"]);
  assert.deepEqual(deviationsOf(counted), ["write-counter"]);
});

test("a different durable position is a different contract", () => {
  assert.notEqual(contractDigest(of({})), contractDigest(of({ geolocation: { latitude: 0, longitude: 0 } })));
});

test("the session's age is counted from the run's sign-in to the start of the child, and absent when the run did not say", () => {
  const signedIn = of({ session: { signedInAt: 1_000_000 - 90_000 } });
  assert.equal(signedIn.session?.ageMs, 90_000);
  assert.equal(signedIn.session?.signedInAt, new Date(1_000_000 - 90_000).toISOString());
  assert.equal(of({}).session, undefined);
});

test("a whole-suite run with the app's own retries is recorded as such; a narrowed one by its file count", () => {
  const whole = recordOfExecution(of({}));
  const narrowed = recordOfExecution(of({ purpose: "fix-retry", specFiles: ["a.spec.ts", "b.spec.ts"], retries: 0, session: { signedInAt: 999_000 } }));
  assert.equal(whole.specFiles, "suite");
  assert.equal(whole.retries, "config");
  assert.equal(narrowed.specFiles, 2);
  assert.equal(narrowed.retries, 0);
  assert.equal(narrowed.sessionAgeMs, 1_000);
  assert.equal(narrowed.digest, whole.digest);
});

test("a purpose whose outcome decides something judges; an observation only measures", () => {
  for (const purpose of ["suite", "acceptance", "fix-retry", "run-spec", "mutant"] as const) assert.equal(kindOfPurpose(purpose), "judging", purpose);
  assert.equal(kindOfPurpose("observation"), "measuring");
});
