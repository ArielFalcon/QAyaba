import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { CLOSED_LOOP_REFUSAL, RUN_SPEC_AGENT, RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { RunSpecUseCase, escapeGrep, type RunSpecDeps } from "@contexts/test-execution/application/run-spec.use-case.ts";
import type { SpecExecutionRequest, SpecExecutionResult } from "@contexts/test-execution/application/ports/run-spec.ports.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const SPEC = 'import { test, expect } from "../fixtures";\ntest("loads", async ({ page }) => { await page.goto("/"); await expect(page).toHaveTitle(/x/); });\n';
const LIMITS = { maxCalls: 3, perCallMs: 60_000, maxDevWrites: 5 };

interface Harness {
  deps: RunSpecDeps;
  capability: RunSpecCapability;
  mirrorDir: string;
  specDir: string;
  executed: SpecExecutionRequest[];
  cleaned: string[];
  renewals: number;
  next: { result?: SpecExecutionResult; throws?: Error };
  write(rel: string, text: string): void;
}

function harness(t: TestContext, overrides: Partial<RunSpecDeps> = {}): Harness {
  const mirrorDir = mkdtempSync(join(tmpdir(), "run-spec-"));
  t.after(() => rmSync(mirrorDir, { recursive: true, force: true }));
  const specDir = join(mirrorDir, "e2e");
  mkdirSync(join(specDir, "flows"), { recursive: true });
  const capability = new RunSpecCapability({ runId: "run-1", limits: LIMITS, expiresAtMs: Number.MAX_SAFE_INTEGER, now: () => 0 });
  capability.bindSession("ses-1");
  const h: Harness = {
    capability, mirrorDir, specDir, executed: [], cleaned: [], renewals: 0,
    next: { result: { verdict: "pass", cases: [{ name: "flows/a.spec.ts › loads", status: "pass", durationMs: 12 }], logs: "RAW STDOUT MUST NOT LEAK" } },
    write: (rel, text) => { mkdirSync(join(specDir, rel, ".."), { recursive: true }); writeFileSync(join(specDir, rel), text); },
    deps: undefined as unknown as RunSpecDeps,
  };
  h.deps = {
    capability,
    specRoot: { mirrorDir, specDir },
    specRelDir: "e2e",
    account: "app/user",
    lock: new AccountLock(),
    executor: { execute: async (request) => { h.executed.push(request); if (h.next.throws) throw h.next.throws; return h.next.result!; } },
    cleanup: { cleanup: async (namespace) => { h.cleaned.push(namespace); } },
    session: { renew: async () => { h.renewals++; return true; } },
    deadline: { remainingMs: () => undefined, describe: () => undefined },
    redact: (text) => text.replaceAll("hunter2", "[REDACTED]"),
    ...overrides,
  };
  h.write("flows/a.spec.ts", SPEC);
  return h;
}

const call = (h: Harness, path: string, extra: { grep?: string; sessionId?: string; agent?: string } = {}) =>
  new RunSpecUseCase(h.deps).run({ sessionId: extra.sessionId ?? "ses-1", agent: extra.agent ?? RUN_SPEC_AGENT, path, ...(extra.grep !== undefined ? { grep: extra.grep } : {}) });

test("a spec that passes is run once in its own namespace and reported without raw output", async (t) => {
  const h = harness(t);
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.status, "passed");
  assert.deepEqual(response.report.tests, [{ title: "flows/a.spec.ts › loads", status: "passed", durationMs: 12 }]);
  assert.deepEqual(h.executed.map((r) => [r.specFile, r.namespace, r.timeoutMs]), [["flows/a.spec.ts", "run-1-rs1", 60_000]]);
  assert.doesNotMatch(JSON.stringify(response), /RAW STDOUT/);
  assert.deepEqual(response.report.budget, { callsLeft: 2, msLeft: undefined, devWritesLeft: 4 });
});

test("the path may carry the e2e prefix, a leading dot-slash, or none", async (t) => {
  const h = harness(t);
  for (const path of ["e2e/flows/a.spec.ts", "./flows/a.spec.ts", "flows/a.spec.ts"]) {
    const response = await call(h, path);
    assert.ok(response.ok, path);
  }
  assert.deepEqual(h.executed.map((r) => r.specFile), ["flows/a.spec.ts", "flows/a.spec.ts", "flows/a.spec.ts"]);
});

test("the probe directory is a place a spec may be run from", async (t) => {
  const h = harness(t);
  h.write(".qa-probe/try.spec.ts", 'import { test } from "../fixtures";\ntest("p", async () => {});\n');
  const response = await call(h, "e2e/.qa-probe/try.spec.ts");
  assert.ok(response.ok);
  assert.equal(h.executed[0]!.specFile, ".qa-probe/try.spec.ts");
});

test("what is not a spec of this suite is refused before a call is spent", async (t) => {
  const h = harness(t);
  h.write("auth.setup.ts", SPEC);
  h.write("flows/notes.txt", SPEC);
  h.write("node_modules/pkg/x.spec.ts", SPEC);
  for (const path of ["/etc/passwd", "../outside.spec.ts", "flows/../../x.spec.ts", "auth.setup.ts", "flows/notes.txt", "-flows/a.spec.ts", "node_modules/pkg/x.spec.ts", ".auth/user.spec.ts", "", "flows/a b.spec.ts"]) {
    const response = await call(h, path);
    assert.equal(response.ok, false, path);
  }
  assert.equal(h.executed.length, 0);
  assert.equal(h.capability.calls, 0);
});

test("a spec that is not there tells the generator to write it first, and costs nothing", async (t) => {
  const h = harness(t);
  const response = await call(h, "flows/missing.spec.ts");
  assert.equal(response.ok, false);
  assert.match(!response.ok ? response.message : "", /not found/i);
  assert.equal(h.capability.calls, 0);
});

test("a link in the way is refused, not followed", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.mirrorDir, "secret.spec.ts"), SPEC);
  symlinkSync(join(h.mirrorDir, "secret.spec.ts"), join(h.specDir, "flows", "link.spec.ts"));
  const response = await call(h, "flows/link.spec.ts");
  assert.equal(response.ok, false);
  assert.equal(h.executed.length, 0);
});

test("a spec that does not take its test from the fixtures is refused, since its writes could not be counted", async (t) => {
  const h = harness(t);
  h.write("flows/raw.spec.ts", 'import { test } from "@playwright/test";\ntest("x", async () => {});\n');
  const response = await call(h, "flows/raw.spec.ts");
  assert.equal(response.ok, false);
  assert.match(!response.ok ? response.message : "", /fixtures/);
  assert.equal(h.executed.length, 0);
});

test("the grep is a literal fragment: escaped, short, and never an option", async (t) => {
  const h = harness(t);
  assert.ok((await call(h, "flows/a.spec.ts", { grep: "adds (one) item [x]" })).ok);
  assert.equal(h.executed[0]!.grep, "adds \\(one\\) item \\[x\\]");
  assert.equal((await call(h, "flows/a.spec.ts", { grep: "x".repeat(201) })).ok, false);
  assert.equal(escapeGrep("a.b*c|d"), "a\\.b\\*c\\|d");
});

test("a session or an agent that does not hold the capability is refused with the capability's own reason", async (t) => {
  const h = harness(t);
  const stranger = await call(h, "flows/a.spec.ts", { sessionId: "ses-other" });
  assert.ok(!stranger.ok && stranger.code === CLOSED_LOOP_REFUSAL.UNKNOWN_SESSION);
  const reviewer = await call(h, "flows/a.spec.ts", { agent: "qa-reviewer" });
  assert.ok(!reviewer.ok && reviewer.code === CLOSED_LOOP_REFUSAL.WRONG_AGENT);
  assert.equal(h.executed.length, 0);
});

test("a revoked capability refuses", async (t) => {
  const h = harness(t);
  h.capability.revoke();
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(!response.ok && response.code === CLOSED_LOOP_REFUSAL.REVOKED);
});

test("the call's time is what the run's deadline allows, never more than its own cap", async (t) => {
  const h = harness(t, { deadline: { remainingMs: () => 40_000, describe: () => undefined } });
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(h.executed[0]!.timeoutMs, 25_000);
  assert.equal(response.report.budget.msLeft, 40_000);
});

test("a deadline with no time left refuses the call", async (t) => {
  const h = harness(t, { deadline: { remainingMs: () => 5_000, describe: () => undefined } });
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(!response.ok && response.code === CLOSED_LOOP_REFUSAL.NO_TIME);
});

test("a failing test is reported with its error, the page it ended on and its tree, each bounded and redacted", async (t) => {
  const h = harness(t);
  const failing: QaCase = {
    name: "flows/a.spec.ts › loads",
    status: "fail",
    detail: `Error: expected hunter2 ${"e".repeat(5000)}`,
    failureDom: `heading: Orders\n${"button: Save\n".repeat(2000)}`,
    finalUrl: "https://dev.example/orders?token=abcdef#frag",
  };
  h.next.result = { verdict: "fail", cases: [failing], logs: "RAW" };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.status, "failed");
  const [only] = response.report.tests;
  assert.equal(only!.status, "failed");
  assert.ok(only!.error!.message.length <= 2000);
  assert.doesNotMatch(only!.error!.message, /hunter2/);
  assert.ok(only!.failureDom!.length <= 8000);
  assert.equal(only!.finalUrl, "https://dev.example/orders");
});

test("a run that timed out is a timeout, one that never produced a verdict is an error, and both are counted", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "infra-error", cases: [], logs: "playwright runner timed out after 60000ms — killed" };
  const timedOut = await call(h, "flows/a.spec.ts");
  assert.ok(timedOut.ok && timedOut.report.status === "timedOut");
  h.next.result = { verdict: "infra-error", cases: [], logs: "browser failed to launch" };
  const errored = await call(h, "flows/a.spec.ts");
  assert.ok(errored.ok && errored.report.status === "error");
  assert.equal(h.capability.calls, 2);
  assert.doesNotMatch(JSON.stringify(errored), /browser failed to launch/);
});

test("an executor that throws is an error report, the call is still spent and the namespace still cleaned", async (t) => {
  const h = harness(t);
  h.next.throws = new Error("spawn exploded");
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok && response.report.status === "error");
  assert.doesNotMatch(JSON.stringify(response), /spawn exploded/);
  assert.deepEqual(h.cleaned, ["run-1-rs1"]);
  assert.equal(h.capability.calls, 1);
});

test("every call is followed by the cleanup pass of its own namespace", async (t) => {
  const h = harness(t);
  await call(h, "flows/a.spec.ts");
  await call(h, "flows/a.spec.ts");
  assert.deepEqual(h.cleaned, ["run-1-rs1", "run-1-rs2"]);
});

test("a cleanup that fails never changes what the call reports", async (t) => {
  const h = harness(t, { cleanup: { cleanup: async () => { throw new Error("cleanup down"); } } });
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok && response.report.status === "passed");
});

test("the ledger holds the sha256 of the bytes that ran, and the writes the fixtures counted", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 3 };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.deepEqual(h.capability.ledger.map((e) => [e.path, e.sha256, e.status, e.devWrites]), [["flows/a.spec.ts", createHash("sha256").update(SPEC).digest("hex"), "passed", 3]]);
  assert.equal(response.report.budget.devWritesLeft, 2);
});

test("a call whose writes could not be counted is charged one, and says so", async (t) => {
  const h = harness(t);
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(h.capability.ledger[0]!.devWrites, 1);
  assert.match(response.report.note ?? "", /could not be counted/);
});

test("once the writes cap is spent the next call is refused, and says so", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 5 };
  assert.ok((await call(h, "flows/a.spec.ts")).ok);
  const refused = await call(h, "flows/a.spec.ts");
  assert.ok(!refused.ok && refused.code === CLOSED_LOOP_REFUSAL.NO_WRITES);
});

test("a spec that left the session on the login page gets the session renewed once, and the report says to run again", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "fail", cases: [{ name: "t", status: "fail", detail: "x", finalUrl: "https://dev.example/login" }], logs: "" };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(h.renewals, 1);
  assert.match(response.report.note ?? "", /session/i);
});

test("a session that cannot be renewed is said, not hidden", async (t) => {
  const h = harness(t, { session: { renew: async () => false } });
  h.next.result = { verdict: "fail", cases: [{ name: "t", status: "fail", detail: "x", failureDom: "textbox: Password" }], logs: "" };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.match(response.report.note ?? "", /could not be renewed/i);
});

test("an ordinary failure does not touch the session", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "fail", cases: [{ name: "t", status: "fail", detail: "x", finalUrl: "https://dev.example/orders" }], logs: "" };
  await call(h, "flows/a.spec.ts");
  assert.equal(h.renewals, 0);
});

test("a call waits for the account when something else holds it, and does not deadlock once it is released", async (t) => {
  const h = harness(t);
  let release!: () => void;
  const held = h.deps.lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const pending = call(h, "flows/a.spec.ts");
  await new Promise((r) => setImmediate(r));
  assert.equal(h.executed.length, 0);
  release();
  await held;
  assert.ok((await pending).ok);
});

test("two calls at once from the same run: the second is told to wait, not queued behind the first", async (t) => {
  const h = harness(t);
  let finish!: () => void;
  h.deps.executor.execute = async (request) => { h.executed.push(request); await new Promise<void>((r) => { finish = r; }); return h.next.result!; };
  const first = call(h, "flows/a.spec.ts");
  await new Promise((r) => setImmediate(r));
  const second = await call(h, "flows/a.spec.ts");
  assert.ok(!second.ok && second.code === CLOSED_LOOP_REFUSAL.BUSY);
  finish();
  assert.ok((await first).ok);
});

test("the path shape the call accepts is the one the Playwright runner insists on", async () => {
  const { SPEC_FILE_RE } = await import("@contexts/test-execution/infrastructure/e2e-execution.runner.ts");
  const { SPEC_PATH_PATTERN } = await import("@contexts/test-execution/application/run-spec.use-case.ts");
  assert.equal(SPEC_PATH_PATTERN.source, SPEC_FILE_RE.source);
});
