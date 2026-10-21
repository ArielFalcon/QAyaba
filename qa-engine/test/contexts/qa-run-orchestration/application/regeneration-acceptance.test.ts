/* The one service every regeneration site shares: accept or reject the specs a regeneration changed. These cases drive it with fake ports (public seam only): a green regeneration is accepted and its specs fingerprinted into the ledger, a rejected one has its pre-turn bytes restored and its created files removed, a changed file whose bytes already hold a green proof is not executed again, a run is capped at MAX_ACCEPTANCE_EXECUTIONS, and an execution that would start with no time left is the run's deadline. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RegenerationAcceptance } from "@contexts/qa-run-orchestration/application/regeneration-acceptance.ts";
import { MAX_ACCEPTANCE_EXECUTIONS } from "@contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts";
import { isRunDeadlineError } from "@kernel/run-deadline.ts";
import type { SpecSnapshot, SpecSnapshotPort } from "@contexts/qa-run-orchestration/application/ports/spec-snapshot.port.ts";
import type { ClosedLoopHandle, ExecutionPort, RunDeadlinePort, ValidationPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/* A snapshot the caller took before the turn: the files that existed, with their bytes. */
const snapshotOf = (files: readonly string[]): SpecSnapshot => ({ files: new Map(files.map((f) => [f, bytesOf(`old:${f}`)])) });

const deadline = (remainingMs?: number): RunDeadlinePort => ({
  arm: () => {},
  describe: () => ({ label: "manual", budgetMs: 60_000 }),
  remainingMs: () => remainingMs,
});

interface Harness {
  service: RegenerationAcceptance;
  snapshot: SpecSnapshotPort;
  restores: Array<{ created: readonly string[] }>;
  executed: Array<{ specFiles: string[]; retries: number; namespace: string }>;
  ledgered: Array<{ file: string; sha256: string }>;
  execute: ExecutionPort["execute"];
}

function harness(): Harness {
  const restores: Harness["restores"] = [];
  const executed: Harness["executed"] = [];
  const ledgered: Harness["ledgered"] = [];
  const snapshot: SpecSnapshotPort = {
    snapshot: async (_dir, files) => ({ files: new Map(files.map((f) => [f, bytesOf(`now:${f}`)])) }),
    restore: async (_dir, _snap, created) => { restores.push({ created }); },
  };
  const service = new RegenerationAcceptance({
    snapshot,
    fingerprint: (b) => `sha-${b.byteLength}`,
    ledger: async (file, sha256) => { ledgered.push({ file, sha256 }); },
  });
  const execute: ExecutionPort["execute"] = async (_dir, opts) => {
    const o = opts as { specFiles: string[]; retries: number; namespace: string };
    executed.push({ specFiles: o.specFiles, retries: o.retries, namespace: o.namespace });
    return { verdict: "pass", cases: [], logs: "" };
  };
  return { service, snapshot, restores, executed, ledgered, execute };
}

const validate: ValidationPort["validate"] = async () => ({ ok: true, errors: [] });

test("a green regeneration is accepted: its changed specs are executed once under their namespace, and fingerprinted into the ledger", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    deadline: deadline(60_000),
    validate,
    execute: h.execute,
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.executedSpecs, ["flows/checkout.spec.ts"]);
    assert.equal(outcome.execution?.verdict, "pass");
    assert.deepEqual(outcome.proof.map((p) => p.file), ["flows/checkout.spec.ts"]);
  }
  assert.deepEqual(h.executed, [{ specFiles: ["flows/checkout.spec.ts"], retries: 0, namespace: "run-1-acc0" }]);
  assert.deepEqual(h.ledgered.map((l) => l.file), ["flows/checkout.spec.ts"]);
  assert.equal(h.ledgered[0]!.sha256, "sha-26", "the ledger carries the sha256 of the accepted bytes");
  assert.equal(h.restores.length, 0, "nothing is restored when the change is accepted");
});

test("a regeneration that fails validation restores its prior bytes and is rejected", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    deadline: deadline(60_000),
    validate: async () => ({ ok: false, errors: ["TS2554: expected 2 arguments"] }),
    execute: h.execute,
  });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.match(outcome.reason, /TS2554/);
  assert.equal(h.restores.length, 1);
  assert.deepEqual(h.restores[0]!.created, [], "the file existed before, so it is restored, not removed");
  assert.equal(h.executed.length, 0);
});

test("a regeneration that fails execution restores its prior bytes and is rejected", async () => {
  const h = harness();
  let ran = 0;
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    deadline: deadline(60_000),
    validate,
    execute: async () => { ran += 1; return { verdict: "fail", cases: [], logs: "" }; },
  });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.match(outcome.reason, /fail/);
  assert.equal(h.restores.length, 1);
  assert.equal(ran, 1, "the execution did run before the bytes were put back");
});

test("a file the turn created is removed when the regeneration is rejected", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/created.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf([]), // nothing existed before the turn
    deadline: deadline(60_000),
    validate: async () => ({ ok: false, errors: ["type error"] }),
    execute: h.execute,
  });

  assert.equal(outcome.kind, "rejected");
  assert.equal(h.restores.length, 1);
  assert.deepEqual(h.restores[0]!.created, ["flows/created.spec.ts"], "the created file is removed, not restored");
});

test("a changed file whose current bytes already hold a green proof is not executed again", async () => {
  const h = harness();
  const closedLoop: Pick<ClosedLoopHandle, "isClosed"> = { isClosed: async () => true };
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    closedLoop,
    deadline: deadline(60_000),
    validate,
    execute: h.execute,
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.executedSpecs, [], "proof reuse skips the execution");
    assert.equal(outcome.execution, undefined);
  }
  assert.equal(h.executed.length, 0);
  assert.equal(h.restores.length, 0);
});

test("at the cap a further regeneration is not executed: its snapshot is restored and the prior result stands", async () => {
  const h = harness();
  const acceptOnce = (i: number) =>
    h.service.accept({
      specDir: "/w/e2e",
      changedSpecFiles: [`flows/spec-${i}.spec.ts`],
      namespace: `run-1-acc${i}`,
      snapshot: snapshotOf([`flows/spec-${i}.spec.ts`]),
      deadline: deadline(60_000),
      validate,
      execute: h.execute,
    });

  for (let i = 0; i < MAX_ACCEPTANCE_EXECUTIONS; i++) {
    const outcome = await acceptOnce(i);
    assert.equal(outcome.kind, "accepted");
  }

  const capped = await acceptOnce(MAX_ACCEPTANCE_EXECUTIONS);

  assert.equal(capped.kind, "cap");
  assert.equal(h.executed.length, MAX_ACCEPTANCE_EXECUTIONS, "no execution beyond the cap");
  assert.equal(h.restores.length, 1, "the capped regeneration has its snapshot restored");
  assert.deepEqual(h.restores[0]!.created, [], "the file existed before, so it is restored");
});

test("no time left before an acceptance execution throws the run's deadline error", async () => {
  const h = harness();
  await assert.rejects(
    h.service.accept({
      specDir: "/w/e2e",
      changedSpecFiles: ["flows/checkout.spec.ts"],
      namespace: "run-1-acc0",
      snapshot: snapshotOf(["flows/checkout.spec.ts"]),
      deadline: deadline(0),
      validate,
      execute: h.execute,
    }),
    (err: unknown) => isRunDeadlineError(err) && (err as { role: string }).role === "acceptance",
  );
  assert.equal(h.executed.length, 0, "the execution never started");
  assert.equal(h.restores.length, 0);
});
