/* The one service every regeneration site shares: accept or reject the specs a regeneration changed. These cases drive it with fake ports (public seam only): a green regeneration is accepted and its specs fingerprinted into the ledger, a rejected one has its pre-turn bytes restored and its created files removed, a changed file whose bytes already hold a green proof is not executed again, a run is capped at MAX_ACCEPTANCE_EXECUTIONS, and an execution that would start with no time left is the run's deadline. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RegenerationAcceptance } from "@contexts/run-orchestration/application/regeneration-acceptance.ts";
import { MAX_ACCEPTANCE_EXECUTIONS } from "@kernel/derive-cycle-backstop.ts";
import { isRunDeadlineError } from "@kernel/run-deadline.ts";
import type { SuiteRestorePoint } from "@contexts/run-orchestration/domain/suite-restore-point.ts";
import type { SuiteRestorePort } from "@contexts/run-orchestration/application/ports/suite-restore.port.ts";
import type { ClosedLoopHandle } from "@contexts/agent-tools/application/index.ts";
import type { ExecutionPort, ValidationPort } from "@contexts/test-execution/application/index.ts";
import type { RunDeadlinePort } from "@contexts/run-orchestration/application/ports/run-deadline.port.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/* A snapshot the caller took before the turn: the files that existed, with their bytes. */
const snapshotOf = (files: readonly string[]): SuiteRestorePoint => ({ files: new Map(files.map((f) => [f, bytesOf(`old:${f}`)])) });

const deadline = (remainingMs?: number): RunDeadlinePort => ({
  arm: () => {},
  describe: () => ({ label: "manual", budgetMs: 60_000 }),
  remainingMs: () => remainingMs,
});

interface Harness {
  service: RegenerationAcceptance;
  snapshot: SuiteRestorePort;
  restores: Array<{ created: readonly string[]; files: readonly string[] }>;
  executed: Array<{ specFiles: string[]; retries: number; namespace: string }>;
  ledgered: Array<{ file: string; sha256: string; bytes?: Uint8Array }>;
  execute: ExecutionPort["execute"];
}

function harness(): Harness {
  const restores: Harness["restores"] = [];
  const executed: Harness["executed"] = [];
  const ledgered: Harness["ledgered"] = [];
  const snapshot: SuiteRestorePort = {
    snapshot: async (_dir, files) => ({ files: new Map(files.map((f) => [f, bytesOf(`now:${f}`)])) }),
    restore: async (_dir, snap, created) => { restores.push({ created, files: [...snap.files.keys()] }); },
  };
  const service = new RegenerationAcceptance({
    snapshot,
    fingerprint: (b) => `sha-${b.byteLength}`,
    ledger: async (entry) => { ledgered.push(entry); },
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
  assert.equal(Buffer.from(h.ledgered[0]!.bytes!).toString("utf8"), "now:flows/checkout.spec.ts", "the ledger carries the accepted bytes themselves, so a later restore has them");
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

test("a failing execution is adopted for an iterative fix-loop round: its bytes stay, and no green proof is recorded", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: "run-1-r1",
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    adoptFailures: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({
      verdict: "fail",
      cases: [{ name: "checkout", status: "fail", file: "flows/checkout.spec.ts", detail: "getByRole resolved to 0 elements" }],
      logs: "",
    }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.equal(outcome.execution?.verdict, "fail", "the loop adopts the round's failing cases to repair from");
    assert.deepEqual(outcome.proof, [], "a failing round's bytes are never proof of green");
  }
  assert.equal(h.restores.length, 0, "the failing bytes stay: the next round repairs them");
  assert.equal(h.ledgered.length, 0, "nothing green is recorded for a failing round");
});

test("an infra-error is never adopted: its bytes are restored and the rejection carries the execution", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: "run-1-r1",
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    adoptFailures: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "infra-error", cases: [], logs: "browser launch failed" }),
  });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.execution?.verdict, "infra-error");
  assert.equal(h.restores.length, 1, "an execution that could not run leaves the prior bytes");
  assert.equal(h.ledgered.length, 0);
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

/*
 * A-2b: a regeneration the contract rejects carries the violations out, so the site that sent the turn
 * can hand them back as facts. The bytes are restored all the same: nothing rejected stays on disk.
 */
test("a contract rejection carries its violations out, and restores the pre-turn bytes", async () => {
  const h = harness();
  const violations = [
    { rule: "weakened-matcher", file: "flows/checkout.spec.ts", clauseId: "assertion-1", before: "strength=exact", after: "strength=presence" },
  ];
  const service = new RegenerationAcceptance({
    snapshot: h.snapshot,
    fingerprint: (b) => `sha-${b.byteLength}`,
    ledger: async () => {},
    contractCheck: async () => ({ ok: false, reason: "contract: weakened-matcher (assertion-1)", violations }),
  });

  const outcome = await service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    deadline: deadline(60_000),
    validate,
    execute: h.execute,
  });

  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(outcome.kind === "rejected" ? outcome.violations : undefined, violations);
  assert.equal(h.restores.length, 1, "a rejected regeneration is rolled back, violations or not");
  assert.deepEqual(h.executed, [], "the contract is checked before any DEV time is spent");
});

/* Per spec file: a regeneration that changed only spec files is judged file by file, so one failing spec does not throw away a green one. */
const caseOf = (file: string, status: "pass" | "fail" | "flaky", name = file): { name: string; status: "pass" | "fail" | "flaky"; file: string } => ({ name, status, file });

test("a regeneration whose execution fails in one spec file keeps every spec file whose cases all passed and restores only the others", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/red.spec.ts", "flows/created.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/green.spec.ts", "flows/red.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({
      verdict: "fail",
      cases: [caseOf("flows/green.spec.ts", "pass", "green a"), caseOf("flows/green.spec.ts", "pass", "green b"), caseOf("flows/red.spec.ts", "pass", "red a"), caseOf("flows/red.spec.ts", "fail", "red b"), caseOf("flows/created.spec.ts", "fail")],
      logs: "",
    }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/green.spec.ts"]);
    assert.deepEqual(outcome.restored, ["flows/red.spec.ts", "flows/created.spec.ts"]);
    assert.deepEqual(outcome.executedSpecs, ["flows/green.spec.ts"], "only the kept files' dumps describe bytes on disk");
    assert.equal(outcome.execution?.verdict, "pass", "the execution the caller merges is the kept files' own, all green");
    assert.deepEqual(outcome.execution?.cases.map((c) => c.name), ["green a", "green b"]);
    assert.deepEqual(outcome.proof.map((p) => p.file), ["flows/green.spec.ts"]);
  }
  assert.deepEqual(h.ledgered.map((l) => l.file), ["flows/green.spec.ts"], "only the kept file's green bytes get a proof");
  assert.deepEqual(h.restores, [{ created: ["flows/created.spec.ts"], files: ["flows/red.spec.ts"] }], "the failing file gets its prior bytes back and the created failing file is removed; the green file is left as it is");
});

test("a spec file whose bytes already hold a green proof is kept when another spec file of the regeneration fails", async () => {
  const h = harness();
  const closedLoop: Pick<ClosedLoopHandle, "isClosed"> = { isClosed: async (files) => files.includes("flows/proven.spec.ts") };
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/proven.spec.ts", "flows/red.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/proven.spec.ts", "flows/red.spec.ts"]),
    independentSpecs: true,
    closedLoop,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/red.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/proven.spec.ts"]);
    assert.deepEqual(outcome.restored, ["flows/red.spec.ts"]);
    assert.deepEqual(outcome.executedSpecs, [], "the kept file was not executed here: its proof was reused");
  }
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/red.spec.ts"] }]);
});

test("a regeneration with no spec file all green is rejected and restored whole, as before", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/a.spec.ts", "flows/b.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/a.spec.ts", "flows/b.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/a.spec.ts", "fail"), caseOf("flows/b.spec.ts", "flaky")], logs: "" }),
  });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.execution?.verdict, "fail");
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/a.spec.ts", "flows/b.spec.ts"] }]);
  assert.equal(h.ledgered.length, 0);
});

test("a fully green regeneration of independent specs is accepted whole, as before", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/a.spec.ts", "flows/b.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/a.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [caseOf("flows/a.spec.ts", "pass"), caseOf("flows/b.spec.ts", "pass")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/a.spec.ts", "flows/b.spec.ts"]);
    assert.deepEqual(outcome.restored, []);
    assert.deepEqual(outcome.executedSpecs, ["flows/a.spec.ts", "flows/b.spec.ts"]);
  }
  assert.deepEqual(h.ledgered.map((l) => l.file), ["flows/a.spec.ts", "flows/b.spec.ts"]);
  assert.equal(h.restores.length, 0);
});

test("a failure no spec file can be blamed for rejects the whole regeneration, even of independent specs", async () => {
  const unattributed = [
    { name: "a failing case with no file", cases: [caseOf("flows/a.spec.ts", "pass"), { name: "setup", status: "fail" as const }] },
    { name: "a failing execution whose cases all passed", cases: [caseOf("flows/a.spec.ts", "pass"), caseOf("flows/b.spec.ts", "pass")] },
  ];
  for (const { name, cases } of unattributed) {
    const h = harness();
    const outcome = await h.service.accept({
      specDir: "/w/e2e",
      changedSpecFiles: ["flows/a.spec.ts", "flows/b.spec.ts"],
      namespace: "run-1-acc0",
      snapshot: snapshotOf(["flows/a.spec.ts", "flows/b.spec.ts"]),
      independentSpecs: true,
      deadline: deadline(60_000),
      validate,
      execute: async () => ({ verdict: "fail", cases, logs: "" }),
    });
    assert.equal(outcome.kind, "rejected", name);
    assert.equal(h.restores.length, 1, name);
    assert.deepEqual(h.restores[0]!.files, ["flows/a.spec.ts", "flows/b.spec.ts"], name);
  }
});

test("a regeneration that changed a file the specs import is judged whole: one failing spec restores them all", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/a.spec.ts", "flows/b.spec.ts"],
    namespace: "run-1-acc0",
    snapshot: snapshotOf(["flows/a.spec.ts", "flows/b.spec.ts"]),
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/a.spec.ts", "pass"), caseOf("flows/b.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "rejected");
  assert.equal(h.restores.length, 1);
  assert.equal(h.ledgered.length, 0);
});
