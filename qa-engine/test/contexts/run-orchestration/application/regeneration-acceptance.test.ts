/* The one service every regeneration site shares: accept or reject the specs a regeneration changed. These cases drive it with fake ports (public seam only): a green regeneration is accepted and its specs fingerprinted into the ledger, a rejected one has its pre-turn bytes restored and its created files removed, every changed file is executed, whatever proof it holds, a run is capped at MAX_ACCEPTANCE_EXECUTIONS, and an execution that would start with no time left is the run's deadline. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RegenerationAcceptance } from "@contexts/run-orchestration/application/regeneration-acceptance.ts";
import { MAX_ACCEPTANCE_EXECUTIONS } from "@contexts/run-orchestration/domain/derive-cycle-backstop.ts";
import { isRunDeadlineError } from "@kernel/run-deadline.ts";
import { acceptanceNamespace } from "@contexts/run-orchestration/domain/acceptance-namespace.ts";
import type { SuiteRestorePoint } from "@contexts/run-orchestration/domain/suite-restore-point.ts";
import type { SuiteRestorePort } from "@contexts/run-orchestration/application/ports/suite-restore.port.ts";
import type { ExecutionPort, ValidationPort } from "@contexts/test-execution/application/index.ts";
import type { RunDeadlinePort } from "@contexts/run-orchestration/application/ports/run-deadline.port.ts";

const NAMESPACE = acceptanceNamespace("run-1", 0);

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/* A snapshot the caller took before the turn: the files that existed, with their bytes. */
const snapshotOf = (files: readonly string[]): SuiteRestorePoint => ({ files: new Map(files.map((f) => [f, bytesOf(`old:${f}`)])) });

const deadline = (allowanceMs?: number): RunDeadlinePort => ({
  arm: () => {},
  describe: () => ({ label: "manual", budgetMs: 60_000 }),
  remainingMs: () => allowanceMs,
  allowance: () => allowanceMs ?? null,
});

interface Harness {
  service: RegenerationAcceptance;
  snapshot: SuiteRestorePort;
  restores: Array<{ created: readonly string[]; files: readonly string[] }>;
  executed: Array<{ specFiles: string[]; retries: number; namespace: string }>;
  ledgered: Array<{ file: string; sha256: string; bytes?: Uint8Array }>;
  execute: ExecutionPort["execute"];
}

function harness(gone: readonly string[] = []): Harness {
  const restores: Harness["restores"] = [];
  const executed: Harness["executed"] = [];
  const ledgered: Harness["ledgered"] = [];
  const snapshot: SuiteRestorePort = {
    snapshot: async (_dir, files) => ({ files: new Map(files.filter((f) => !gone.includes(f)).map((f) => [f, bytesOf(`now:${f}`)])) }),
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
    return { verdict: "pass", cases: o.specFiles.map((file) => caseOf(file, "pass")), logs: "" };
  };
  return { service, snapshot, restores, executed, ledgered, execute };
}

const validate: ValidationPort["validate"] = async () => ({ ok: true, errors: [] });

test("a green regeneration is accepted: its changed specs are executed once under their namespace, and fingerprinted into the ledger", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: NAMESPACE,
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
  assert.deepEqual(h.executed, [{ specFiles: ["flows/checkout.spec.ts"], retries: 0, namespace: NAMESPACE }]);
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
    namespace: NAMESPACE,
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
    namespace: NAMESPACE,
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

test("an infra-error is never adopted: its bytes are restored whole and the rejection carries the execution, whatever cases it reports", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts", "flows/cart.spec.ts"],
    namespace: "run-1-r1",
    snapshot: snapshotOf(["flows/checkout.spec.ts", "flows/cart.spec.ts"]),
    adoptFailures: true,
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "infra-error", cases: [caseOf("flows/checkout.spec.ts", "pass"), caseOf("flows/cart.spec.ts", "fail")], logs: "browser launch failed" }),
  });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.execution?.verdict, "infra-error");
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/checkout.spec.ts", "flows/cart.spec.ts"] }], "an execution that could not run leaves the prior bytes of every file, even one with a green case");
  assert.equal(h.ledgered.length, 0);
});

test("a file the turn created is removed when the regeneration is rejected", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/created.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf([]), // nothing existed before the turn
    deadline: deadline(60_000),
    validate: async () => ({ ok: false, errors: ["type error"] }),
    execute: h.execute,
  });

  assert.equal(outcome.kind, "rejected");
  assert.equal(h.restores.length, 1);
  assert.deepEqual(h.restores[0]!.created, ["flows/created.spec.ts"], "the created file is removed, not restored");
});

test("every changed file is executed and has a case in the outcome, whatever proof its bytes held before", async () => {
  const h = harness();
  const files = ["flows/proved.spec.ts", "flows/open.spec.ts"];
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: files,
    namespace: NAMESPACE,
    snapshot: snapshotOf(files),
    deadline: deadline(60_000),
    validate,
    execute: async (_dir, opts) => {
      const o = opts as { specFiles: string[]; retries: number; namespace: string };
      h.executed.push({ specFiles: o.specFiles, retries: o.retries, namespace: o.namespace });
      return { verdict: "pass", cases: o.specFiles.map((file) => caseOf(file, "pass")), logs: "" };
    },
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.executedSpecs, files);
    assert.deepEqual(outcome.kept, files);
    assert.deepEqual(outcome.execution?.cases.map((c) => c.file), files, "a case for each kept file");
  }
  assert.deepEqual(h.executed, [{ specFiles: files, retries: 0, namespace: NAMESPACE }]);
});

test("a regeneration that changed no spec file is accepted with nothing executed, even with no execution left and no time left", async () => {
  const h = harness();
  for (let i = 0; i < MAX_ACCEPTANCE_EXECUTIONS; i++) assert.equal(h.service.spendExecution(), true);
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: [],
    namespace: NAMESPACE,
    snapshot: snapshotOf([]),
    deadline: deadline(0),
    validate,
    execute: h.execute,
  });

  assert.equal(outcome.kind, "accepted", "nothing to execute, so neither the cap nor the deadline applies");
  if (outcome.kind === "accepted") {
    assert.equal(outcome.execution, undefined);
    assert.deepEqual([outcome.executedSpecs, outcome.kept, outcome.restored, outcome.proof], [[], [], [], []]);
  }
  assert.equal(h.executed.length, 0);
  assert.equal(h.ledgered.length, 0);
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
      namespace: NAMESPACE,
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

/* The intent lock reads the changed specs and records what moved; it never decides the round. */
test("the contract observation sees the changed specs before validation and never rejects them", async () => {
  const h = harness();
  const observed: Array<readonly string[]> = [];
  const service = new RegenerationAcceptance({
    snapshot: h.snapshot,
    fingerprint: (b) => `sha-${b.byteLength}`,
    ledger: async () => {},
    observeContract: async (files) => { observed.push(files); },
  });

  const outcome = await service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/checkout.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/checkout.spec.ts"]),
    deadline: deadline(60_000),
    validate,
    execute: h.execute,
  });

  assert.deepEqual(observed, [["flows/checkout.spec.ts"]]);
  assert.equal(outcome.kind, "accepted");
  assert.equal(h.restores.length, 0, "nothing is rolled back for what the contract observed");
});

/* Per spec file: a regeneration that changed only spec files is judged file by file, so one failing spec does not throw away a green one. */
const caseOf = (file: string, status: "pass" | "fail" | "flaky", name = file): { name: string; status: "pass" | "fail" | "flaky"; file: string } => ({ name, status, file });

test("a regeneration whose execution fails in one spec file keeps every spec file whose cases all passed and restores only the others", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/red.spec.ts", "flows/created.spec.ts"],
    namespace: NAMESPACE,
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

test("a spec file that was proved earlier is judged on its own cases when another spec file of the regeneration fails", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/proved.spec.ts", "flows/red.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/proved.spec.ts", "flows/red.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/proved.spec.ts", "pass"), caseOf("flows/red.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/proved.spec.ts"]);
    assert.deepEqual(outcome.restored, ["flows/red.spec.ts"]);
    assert.deepEqual(outcome.executedSpecs, ["flows/proved.spec.ts"], "the kept file executed here");
    assert.deepEqual(outcome.execution?.cases.map((c) => c.file), ["flows/proved.spec.ts"]);
  }
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/red.spec.ts"] }]);
});

test("a spec file with no case in a failing execution is restored, not kept on a pass it cannot show", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/silent.spec.ts", "flows/red.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/silent.spec.ts", "flows/red.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/red.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "rejected", "no file is left standing, so the regeneration is rejected whole");
});

test("a spec file with no case is restored while another spec file stands: the record holds only the cases of the files it kept", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/silent.spec.ts", "flows/red.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/green.spec.ts", "flows/silent.spec.ts", "flows/red.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/green.spec.ts", "pass"), caseOf("flows/red.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/green.spec.ts"]);
    assert.deepEqual(outcome.restored, ["flows/silent.spec.ts", "flows/red.spec.ts"], "a file the execution showed no case of has no pass to stand on");
    assert.deepEqual(outcome.execution?.cases.map((c) => c.file), ["flows/green.spec.ts"]);
  }
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/silent.spec.ts", "flows/red.spec.ts"] }]);
});

/* An acceptance keeps a spec file only with a case of it: a file that still exists and that the execution showed no case of has no result to stand on, whatever the verdict. */
test("a passing execution that shows no case of an existing spec file restores that file and keeps the others", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/silent.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/green.spec.ts", "flows/silent.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [caseOf("flows/green.spec.ts", "pass")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/green.spec.ts"]);
    assert.deepEqual(outcome.restored, ["flows/silent.spec.ts"]);
    assert.deepEqual(outcome.executedSpecs, ["flows/green.spec.ts"]);
    assert.equal(outcome.execution?.verdict, "pass");
    assert.deepEqual(outcome.execution?.cases.map((c) => c.file), ["flows/green.spec.ts"]);
    assert.deepEqual(outcome.proof.map((p) => p.file), ["flows/green.spec.ts"], "no proof for bytes that showed no case");
  }
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/silent.spec.ts"] }]);
  assert.deepEqual(h.ledgered.map((l) => l.file), ["flows/green.spec.ts"]);
});

test("a passing execution that shows no case of a spec file the turn created removes that file", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/created.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/green.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [caseOf("flows/green.spec.ts", "pass")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  assert.deepEqual(h.restores, [{ created: ["flows/created.spec.ts"], files: [] }]);
});

test("a passing execution that shows no case of any existing spec file rejects the regeneration whole", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/silent.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/silent.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
  });

  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/silent.spec.ts"] }]);
  assert.equal(h.ledgered.length, 0);
});

test("a regeneration that changed a file the specs import is judged whole: a spec file with no case restores them all", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/silent.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/green.spec.ts", "flows/silent.spec.ts"]),
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [caseOf("flows/green.spec.ts", "pass")], logs: "" }),
  });

  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/green.spec.ts", "flows/silent.spec.ts"] }]);
});

/* A skipped test that was already in a file's prior bytes: the regeneration did not make it, so it neither blocks the file nor proves it. */
const ALREADY_SKIPPED = { cases: [], skippedTests: [{ name: "needs a seeded account", file: "flows/skipped.spec.ts" }] };

test("a spec file whose tests all skipped, as they did before, loaded and showed it: it is kept beside the files that ran, with no proof and no case recorded for it", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/skipped.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/green.spec.ts", "flows/skipped.spec.ts"]),
    prior: ALREADY_SKIPPED,
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [caseOf("flows/green.spec.ts", "pass")], skippedTests: [{ name: "needs a seeded account", file: "flows/skipped.spec.ts" }], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/green.spec.ts", "flows/skipped.spec.ts"]);
    assert.deepEqual(outcome.restored, []);
    assert.deepEqual(outcome.execution?.cases.map((c) => c.file), ["flows/green.spec.ts"], "a skipped test is not a case: nothing ran");
    assert.deepEqual(outcome.proof.map((p) => p.file), ["flows/green.spec.ts"], "a kept file with no executed case gets no proof: nothing of it ran");
  }
  assert.equal(h.restores.length, 0, "no bytes are given back: the skipped file loaded");
  assert.deepEqual(h.ledgered.map((l) => l.file), ["flows/green.spec.ts"]);
});

test("a regeneration whose only changed spec file has all its tests skipped, as before, is accepted without a proof, judged whole or file by file", async () => {
  for (const independentSpecs of [true, false]) {
    const h = harness();
    const outcome = await h.service.accept({
      specDir: "/w/e2e",
      changedSpecFiles: ["flows/skipped.spec.ts"],
      namespace: NAMESPACE,
      snapshot: snapshotOf(["flows/skipped.spec.ts"]),
      prior: { cases: [], skippedTests: [{ name: "fixme", file: "flows/skipped.spec.ts" }] },
      ...(independentSpecs ? { independentSpecs } : {}),
      deadline: deadline(60_000),
      validate,
      execute: async () => ({ verdict: "pass", cases: [], skippedTests: [{ name: "fixme", file: "flows/skipped.spec.ts" }], logs: "" }),
    });

    assert.equal(outcome.kind, "accepted", `independentSpecs ${independentSpecs}`);
    assert.equal(h.restores.length, 0);
    assert.equal(h.ledgered.length, 0, "nothing of the file ran, so nothing of it is proven");
  }
});

test("a skipped test of one file does not vouch for another spec file that showed nothing", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/skipped.spec.ts", "flows/silent.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/skipped.spec.ts", "flows/silent.spec.ts"]),
    prior: { cases: [], skippedTests: [{ name: "fixme", file: "flows/skipped.spec.ts" }] },
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [], skippedTests: [{ name: "fixme", file: "flows/skipped.spec.ts" }], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/skipped.spec.ts"]);
    assert.deepEqual(outcome.restored, ["flows/silent.spec.ts"], "a file the report said nothing of did not load");
  }
});

test("a spec file the turn deleted has no case by nature: its deletion stands in a passing execution", async () => {
  const h = harness(["flows/deleted.spec.ts"]);
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/green.spec.ts", "flows/deleted.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/green.spec.ts", "flows/deleted.spec.ts"]),
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "pass", cases: [caseOf("flows/green.spec.ts", "pass")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/green.spec.ts", "flows/deleted.spec.ts"]);
    assert.deepEqual(outcome.restored, []);
    assert.deepEqual(outcome.proof.map((p) => p.file), ["flows/green.spec.ts"], "a deleted file has no bytes to prove");
  }
  assert.equal(h.restores.length, 0, "the deletion is not undone");
});

test("an adopted round restores a spec file with no case and keeps the failing cases of the others", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/red.spec.ts", "flows/silent.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/red.spec.ts", "flows/silent.spec.ts"]),
    adoptFailures: true,
    independentSpecs: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/red.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/red.spec.ts"]);
    assert.deepEqual(outcome.restored, ["flows/silent.spec.ts"]);
    assert.equal(outcome.execution?.verdict, "fail", "the adopted round is still failing");
    assert.deepEqual(outcome.execution?.cases.map((c) => c.file), ["flows/red.spec.ts"]);
    assert.deepEqual(outcome.proof, [], "a failing round's bytes are never proof of green");
  }
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/silent.spec.ts"] }]);
});

test("an adopted round whose changes are judged whole is rejected when a spec file shows no case", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/red.spec.ts", "flows/silent.spec.ts"],
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/red.spec.ts", "flows/silent.spec.ts"]),
    adoptFailures: true,
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/red.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(h.restores, [{ created: [], files: ["flows/red.spec.ts", "flows/silent.spec.ts"] }]);
});

test("a regeneration with no spec file all green is rejected and restored whole, as before", async () => {
  const h = harness();
  const outcome = await h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: ["flows/a.spec.ts", "flows/b.spec.ts"],
    namespace: NAMESPACE,
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
    namespace: NAMESPACE,
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
      namespace: NAMESPACE,
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
    namespace: NAMESPACE,
    snapshot: snapshotOf(["flows/a.spec.ts", "flows/b.spec.ts"]),
    deadline: deadline(60_000),
    validate,
    execute: async () => ({ verdict: "fail", cases: [caseOf("flows/a.spec.ts", "pass"), caseOf("flows/b.spec.ts", "fail")], logs: "" }),
  });

  assert.equal(outcome.kind, "rejected");
  assert.equal(h.restores.length, 1);
  assert.equal(h.ledgered.length, 0);
});

/* What a regeneration may not do to a file's tests is read from their declared modes and counts per file, never from their titles. */
type Mode = { name?: string; status?: "pass" | "fail"; expectedStatus?: "passed" | "failed" };
const test_ = (file: string, over: Mode = {}) => ({ name: over.name ?? `${file} › t`, status: over.status ?? ("pass" as const), expectedStatus: over.expectedStatus ?? ("passed" as const), file });
const skippedIn = (file: string, name: string, annotation = "skip") => ({ name, file, annotation });

const A = "flows/a.spec.ts";
/* A file with a failing test, a passing one, and a test already marked test.fail() before the round. */
const PRIOR_FAILING = { cases: [test_(A, { name: "pays by card", status: "fail" }), test_(A, { name: "other" })] };
const PRIOR_GREEN = { cases: [test_(A, { name: "pays by card" })] };
const PRIOR_WITH_KNOWN_BUG = { cases: [test_(A, { name: "known app bug", expectedStatus: "failed" }), test_(A, { name: "broken", status: "fail" })] };

const accepting = (h: Harness, over: { prior?: { cases: ReturnType<typeof test_>[]; skippedTests?: ReturnType<typeof skippedIn>[] }; named?: { file: string; name: string }[]; independentSpecs?: boolean; adoptFailures?: boolean; files?: string[]; execute: ExecutionPort["execute"] }) =>
  h.service.accept({
    specDir: "/w/e2e",
    changedSpecFiles: over.files ?? [A],
    namespace: NAMESPACE,
    snapshot: snapshotOf(over.files ?? [A]),
    ...(over.independentSpecs ? { independentSpecs: true } : {}),
    ...(over.adoptFailures ? { adoptFailures: true } : {}),
    ...(over.prior ? { prior: over.prior } : {}),
    ...(over.named ? { named: over.named } : {}),
    deadline: deadline(60_000),
    validate,
    execute: over.execute,
  });

const executing = (cases: ReturnType<typeof test_>[], skippedTests: ReturnType<typeof skippedIn>[] = []): ExecutionPort["execute"] => async () => ({ verdict: "pass", cases, ...(skippedTests.length > 0 ? { skippedTests } : {}), logs: "" });

test("a failing test the regeneration turned into a skip is not a pass: its file gets its prior bytes back and a sibling file stands", async () => {
  const h = harness();
  const B = "flows/b.spec.ts";
  const outcome = await accepting(h, {
    files: [A, B],
    independentSpecs: true,
    prior: PRIOR_FAILING,
    execute: executing([test_(A, { name: "other" }), test_(B)], [skippedIn(A, "pays by card", "fixme")]),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, [B]);
    assert.deepEqual(outcome.restored, [A]);
    assert.deepEqual(outcome.proof.map((p) => p.file), [B]);
  }
  assert.deepEqual(h.restores.map((r) => r.files), [[A]]);
});

test("a test that ran before and now runs with expectedStatus failed is not a pass", async () => {
  const h = harness();
  const outcome = await accepting(h, { prior: PRIOR_GREEN, execute: executing([test_(A, { name: "pays by card", expectedStatus: "failed" })]) });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.match(outcome.reason, /expected to fail/);
  assert.equal(h.restores.length, 1);
  assert.equal(h.ledgered.length, 0, "no bytes of a test that proves nothing enter the ledger");
});

test("a round that adopts failures still rejects a failing test turned into a skip, whole: the round's bytes are given back", async () => {
  const h = harness();
  const outcome = await accepting(h, { adoptFailures: true, prior: PRIOR_FAILING, execute: executing([test_(A, { name: "other" })], [skippedIn(A, "pays by card", "fixme")]) });

  assert.equal(outcome.kind, "rejected");
  assert.equal(h.restores.length, 1);
});

test("a failing execution beside an unproven file restores the unproven file too", async () => {
  const h = harness();
  const outcome = await accepting(h, {
    files: [A, "flows/b.spec.ts", "flows/c.spec.ts"],
    independentSpecs: true,
    prior: PRIOR_FAILING,
    execute: async () => ({ verdict: "fail", cases: [test_(A, { name: "other" }), test_("flows/b.spec.ts"), test_("flows/c.spec.ts", { status: "fail" })], skippedTests: [skippedIn(A, "pays by card")], logs: "" }),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") {
    assert.deepEqual(outcome.kept, ["flows/b.spec.ts"]);
    assert.deepEqual(outcome.restored, [A, "flows/c.spec.ts"]);
  }
});

test("a failing test renamed by the round that fixes it is a pass: the file still reports as many tests", async () => {
  const h = harness();
  const outcome = await accepting(h, { adoptFailures: true, prior: PRIOR_FAILING, execute: executing([test_(A, { name: "pays by credit card" }), test_(A, { name: "other" })]) });

  assert.equal(outcome.kind, "accepted");
});

test("a failing test the round deleted while its file keeps other tests is not a pass", async () => {
  const h = harness();
  const outcome = await accepting(h, { adoptFailures: true, prior: PRIOR_FAILING, execute: executing([test_(A, { name: "other" })]) });

  assert.equal(outcome.kind, "rejected");
  assert.equal(h.restores.length, 1);
});

test("a skipped test that never ran before is one more skip: the round that adds it, however it is titled, is refused", async () => {
  const h = harness();
  const outcome = await accepting(h, { prior: PRIOR_GREEN, execute: executing([test_(A, { name: "pays by card" })], [skippedIn(A, "needs a seeded account", "fixme")]) });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.match(outcome.reason, /1 more skipped test/);
  assert.equal(h.restores.length, 1);
});

test("a failing test renamed and then skipped, with a filler test that keeps the count, is refused: the rule reads counts, not titles", async () => {
  const h = harness();
  const outcome = await accepting(h, {
    prior: PRIOR_FAILING,
    execute: executing([test_(A, { name: "other" }), test_(A, { name: "page has a title" })], [skippedIn(A, "pays by card (later)")]),
  });

  assert.equal(outcome.kind, "rejected");
  assert.equal(h.restores.length, 1);
});

test("a failing test renamed and then marked test.fail() is refused: one more test expected to fail", async () => {
  const h = harness();
  const outcome = await accepting(h, {
    prior: PRIOR_FAILING,
    execute: executing([test_(A, { name: "pays by card (known)", expectedStatus: "failed" }), test_(A, { name: "other" })]),
  });

  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.match(outcome.reason, /1 more test\(s\) expected to fail/);
});

test("a test.fail() test that was already in the prior bytes does not block the fix of another test of the file", async () => {
  const h = harness();
  const outcome = await accepting(h, {
    prior: PRIOR_WITH_KNOWN_BUG,
    execute: executing([test_(A, { name: "known app bug", expectedStatus: "failed" }), test_(A, { name: "broken" })]),
  });

  assert.equal(outcome.kind, "accepted");
  if (outcome.kind === "accepted") assert.deepEqual(outcome.proof.map((p) => p.file), [A], "the fixed test is a real pass, so the file is proven");
  assert.equal(h.restores.length, 0);
});

test("a skipped test that was already in the prior bytes does not block the fix of another test of the file", async () => {
  const h = harness();
  const outcome = await accepting(h, {
    prior: { cases: [test_(A, { name: "broken", status: "fail" })], skippedTests: [skippedIn(A, "older", "fixme")] },
    execute: executing([test_(A, { name: "broken" })], [skippedIn(A, "older", "fixme")]),
  });

  assert.equal(outcome.kind, "accepted");
});

test("a file whose only test is marked test.fail() is kept when it was so before, and gets no proof", async () => {
  const h = harness();
  const outcome = await accepting(h, {
    prior: { cases: [test_(A, { name: "known bug", expectedStatus: "failed" })] },
    execute: executing([test_(A, { name: "known bug", expectedStatus: "failed" })]),
  });

  assert.equal(outcome.kind, "accepted");
  assert.equal(h.ledgered.length, 0);
  if (outcome.kind === "accepted") assert.deepEqual(outcome.proof, []);
});

test("a test a correction named that comes back skipped or expected to fail is refused, though it never ran before", async () => {
  for (const [form, execute] of [
    ["skipped", executing([test_(A, { name: "other" })], [skippedIn(A, "pays by card")])],
    ["expected to fail", executing([test_(A, { name: "pays by card", expectedStatus: "failed" }), test_(A, { name: "other" })])],
  ] as const) {
    const h = harness();
    /* The prior run already had the skip (or the expected failure) of the named test, so by the counts alone nothing grew. */
    const prior = form === "skipped"
      ? { cases: [test_(A, { name: "other" })], skippedTests: [skippedIn(A, "pays by card")] }
      : { cases: [test_(A, { name: "pays by card", expectedStatus: "failed" as const }), test_(A, { name: "other" })] };
    const outcome = await accepting(h, { prior, named: [{ file: A, name: "pays by card" }], execute });

    assert.equal(outcome.kind, "rejected", form);
    if (outcome.kind === "rejected") assert.match(outcome.reason, /named/, form);
  }
});

test("the same test, not named by any correction, stands when it was already skipped", async () => {
  const h = harness();
  const outcome = await accepting(h, {
    prior: { cases: [test_(A, { name: "other" })], skippedTests: [skippedIn(A, "pays by card")] },
    execute: executing([test_(A, { name: "other" })], [skippedIn(A, "pays by card")]),
  });

  assert.equal(outcome.kind, "accepted");
});

test("a spec file the run knew nothing of before has every skip it reports counted as new", async () => {
  const h = harness();
  const outcome = await accepting(h, { execute: executing([test_(A, { name: "pays by card" })], [skippedIn(A, "later")]) });

  assert.equal(outcome.kind, "rejected");
});
