/*
 * What a failure does to a run, without a run: each kind of error is told apart, every kind has an action for every class of step,
 * and a wrapped step takes the action its class calls for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTimeoutError, InfraError, UntrustedGitTreeError } from "@kernel/domain-error.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { RunAbortedError } from "@contexts/qa-run-orchestration/application/run-flow/abort.ts";
import { FAILURE_KINDS, POLICY, PublicationFailedError, ProbeSweepError, STEP_CLASSES, actionFor, carryOn, classifyFailure, guarded } from "@contexts/qa-run-orchestration/application/run-flow/failure-policy.ts";
import { runEnd, type RunEnd } from "@contexts/qa-run-orchestration/application/run-flow/run-end.ts";
import type { EndReason } from "@contexts/qa-run-orchestration/application/run-flow/end-reason.ts";
import { SandboxUnavailableError } from "../../../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";

const deadline = new RunDeadlineExceededError(1000, "diff-tiny", "generator", "mid-turn");

const CASES: ReadonlyArray<[string, unknown, (typeof FAILURE_KINDS)[number]]> = [
  ["a cancelled run", new RunAbortedError(), "aborted"],
  ["the run deadline", deadline, "run-deadline"],
  ["a deadline that crossed a realm boundary", Object.assign(new Error("run deadline"), { name: "RunDeadlineExceededError" }), "run-deadline"],
  ["a sandbox that cannot be trusted", new SandboxUnavailableError("egress", "the egress filter is down"), "sandbox-unavailable"],
  ["a sandbox scope the run could not open", new SandboxUnavailableError("scope", "a process of an earlier run holds the uid"), "unknown"],
  ["throwaway specs that could not be swept", new ProbeSweepError("EACCES"), "probe-sweep"],
  ["an untrusted git tree", new UntrustedGitTreeError("the git dir is not ours"), "untrusted-tree"],
  ["a publication that failed", new PublicationFailedError("github 502"), "publication"],
  ["a collaborator the infrastructure lost", new InfraError("the agent runtime went away"), "integration"],
  ["an agent turn that timed out", new AgentTimeoutError("generator", 1000), "integration"],
  ["a bug", new TypeError("x is not a function"), "unknown"],
  ["a thrown string", "boom", "unknown"],
];

for (const [what, err, kind] of CASES) {
  test(`${what} is a ${kind} failure`, () => {
    assert.equal(classifyFailure(err), kind);
  });
}

test("the run deadline is told apart from the infrastructure faults it is a kind of", () => {
  assert.equal(deadline instanceof InfraError, true);
  assert.equal(classifyFailure(deadline), "run-deadline");
});

test("every kind of failure has an action for every class of step", () => {
  assert.deepEqual(Object.keys(POLICY).sort(), [...FAILURE_KINDS].sort());
  for (const kind of FAILURE_KINDS) assert.deepEqual(Object.keys(POLICY[kind]).sort(), [...STEP_CLASSES].sort(), kind);
});

test("a failure that ends the run names the same reason whatever step failed", () => {
  const ends: Array<[(typeof FAILURE_KINDS)[number], EndReason]> = [
    ["aborted", "aborted"],
    ["run-deadline", "run-deadline"],
    ["sandbox-unavailable", "sandbox-unavailable"],
    ["probe-sweep", "probe-sweep-failed"],
  ];
  for (const [kind, reason] of ends) for (const stepClass of STEP_CLASSES) assert.deepEqual(POLICY[kind][stepClass], { do: "end", reason }, `${kind} in a ${stepClass} step`);
});

test("an untrusted git tree is rethrown from every class of step", () => {
  for (const stepClass of STEP_CLASSES) assert.deepEqual(POLICY["untrusted-tree"][stepClass], { do: "rethrow" });
});

test("only a step off the verdict's path carries on past a fault of a collaborator, and only the publish step turns a failed publication into an end", () => {
  for (const kind of ["integration", "unknown"] as const) {
    assert.deepEqual(POLICY[kind]["off-path"], { do: "fail-open" });
    for (const stepClass of ["required", "proven", "publish"] as const) assert.deepEqual(POLICY[kind][stepClass], { do: "rethrow" });
  }
  assert.deepEqual(POLICY.publication.publish, { do: "end", reason: "publication-failed" });
  assert.deepEqual(POLICY.publication["off-path"], { do: "rethrow" });
});

const endOf = (reason: EndReason): RunEnd => (reason === "aborted" ? runEnd("aborted") : runEnd("publication-failed", { note: reason }));

test("a wrapped step that succeeds returns what it returned", async () => {
  assert.deepEqual(await guarded({ id: "set-up-project", class: "required" }, async () => ({ update: { x: 1 } }), endOf), { update: { x: 1 } });
});

test("a wrapped step whose failure ends the run returns that end", async () => {
  assert.deepEqual(await guarded({ id: "index-mirror", class: "required" }, async () => { throw new RunAbortedError(); }, endOf), { end: runEnd("aborted") });
});

test("a wrapped step takes the action of its class: an off-path fault is carried on aloud, a required one is rethrown as the identical error", async () => {
  const bug = new TypeError("x is not a function");
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    assert.equal(await guarded({ id: "index-mirror", class: "off-path" }, async () => { throw bug; }, endOf), undefined);
    await assert.rejects(guarded({ id: "set-up-project", class: "required" }, async () => { throw bug; }, endOf), (thrown) => thrown === bug);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /index-mirror: unknown fault carried on \(off-path step\): x is not a function/);
});

test("a deadline or an untrusted tree is never carried on, even by a step off the verdict's path", async () => {
  assert.deepEqual(await guarded({ id: "index-mirror", class: "off-path" }, async () => { throw deadline; }, (reason) => runEnd(reason as "aborted")), { end: runEnd("run-deadline" as "aborted") });
  const untrusted = new UntrustedGitTreeError("the git dir is not ours");
  await assert.rejects(guarded({ id: "index-mirror", class: "off-path" }, async () => { throw untrusted; }, endOf), (thrown) => thrown === untrusted);
});

test("a catch that carries on past a fault lets an ordinary fault go and throws the ones that must reach the run", () => {
  assert.doesNotThrow(() => carryOn(new Error("npm ci failed")));
  assert.doesNotThrow(() => carryOn(new InfraError("the agent runtime went away")));
  for (const err of [deadline, new RunAbortedError(), new UntrustedGitTreeError("x"), new ProbeSweepError("x"), new SandboxUnavailableError("egress", "x")]) {
    assert.throws(() => carryOn(err), (thrown) => thrown === err);
  }
});

test("the policy and the action lookup agree", () => {
  assert.deepEqual(actionFor(new PublicationFailedError("x"), "publish"), POLICY.publication.publish);
});
