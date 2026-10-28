import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { RunDevWriteLedger } from "@contexts/test-execution/domain/run-dev-write-ledger.ts";
import { CLOSED_LOOP_REFUSAL, RUN_SPEC_FLOW_AGENT, RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { MAX_ERROR_CHARS, MAX_REPORTED_LOAD_ERRORS, MAX_REPORTED_TESTS, MAX_TITLE_CHARS, RunSpecUseCase, escapeGrep, type RunSpecDeps } from "@contexts/test-execution/application/run-spec.use-case.ts";
import type { SpecExecutionRequest, SpecExecutionResult } from "@contexts/test-execution/domain/spec-executor.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { typescriptSpecFixtures } from "../../../../src/shared-infrastructure/spec-fixtures-import.ts";

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
    next: { result: { verdict: "pass", cases: [{ name: "flows/a.spec.ts › loads", status: "pass", durationMs: 12 }], logs: "RAW STDOUT MUST NOT LEAK", devWrites: 0 } },
    write: (rel, text) => { mkdirSync(join(specDir, rel, ".."), { recursive: true }); writeFileSync(join(specDir, rel), text); },
    deps: undefined as unknown as RunSpecDeps,
  };
  h.deps = {
    capability,
    specRoot: { mirrorDir, specDir },
    specFiles: confinedSpecFiles,
    fixtures: typescriptSpecFixtures,
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
  new RunSpecUseCase(h.deps).run({ sessionId: extra.sessionId ?? "ses-1", agent: extra.agent ?? RUN_SPEC_FLOW_AGENT, path, ...(extra.grep !== undefined ? { grep: extra.grep } : {}) });

test("a spec that passes is run once in its own namespace and reported without raw output", async (t) => {
  const h = harness(t);
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.status, "passed");
  assert.deepEqual(response.report.tests, [], "a test that passed is a count, not a title");
  assert.equal(response.report.passedTests, 1);
  assert.deepEqual(h.executed.map((r) => [r.specFile, r.namespace, r.timeoutMs]), [["flows/a.spec.ts", "run-1-rs1", 60_000]]);
  assert.doesNotMatch(JSON.stringify(response), /RAW STDOUT/);
  assert.deepEqual(response.report.budget, { callsLeft: 2, msLeft: undefined, devWritesLeft: 5 });
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

test("a call may be limited to the one spec its holder was given, and any other is refused before a call is spent, whatever its form", async (t) => {
  const h = harness(t, { allowPath: (rel) => rel === "flows/a.spec.ts", allowedDescription: "e2e/flows/a.spec.ts" });
  h.write("flows/b.spec.ts", SPEC);
  h.write(".qa-probe/try.spec.ts", SPEC);
  for (const path of ["flows/b.spec.ts", "e2e/flows/b.spec.ts", ".qa-probe/try.spec.ts", "flows/./b.spec.ts"]) {
    const response = await call(h, path);
    assert.equal(response.ok, false, path);
    assert.match(!response.ok ? response.message : "", /flows\/a\.spec\.ts/, "the refusal names the spec it may run");
  }
  assert.equal(h.executed.length, 0);
  assert.equal(h.capability.calls, 0);
  for (const path of ["flows/a.spec.ts", "e2e/flows/a.spec.ts", "./flows/a.spec.ts"]) assert.ok((await call(h, path)).ok, path);
});

test("what is not a spec of this suite is refused before a call is spent", async (t) => {
  const h = harness(t);
  h.write("auth.setup.ts", SPEC);
  h.write("flows/notes.txt", SPEC);
  h.write("node_modules/pkg/x.spec.ts", SPEC);
  for (const path of ["/etc/passwd", "../outside.spec.ts", "flows/../../x.spec.ts", "auth.setup.ts", "flows/notes.txt", "-flows/a.spec.ts", "node_modules/pkg/x.spec.ts", ".auth/user.spec.ts", "", "flows/a b.spec.ts", "..spec.ts", "flows/..spec.ts", ".spec.ts"]) {
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
  h.next.result = { verdict: "infra-error", cases: [], logs: "playwright runner timed out after 60000ms — killed", devWrites: 0 };
  const timedOut = await call(h, "flows/a.spec.ts");
  assert.ok(timedOut.ok && timedOut.report.status === "timedOut");
  h.next.result = { verdict: "infra-error", cases: [], logs: "browser failed to launch", devWrites: 0 };
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

test("the requests behind a call's writes are kept on its ledger entry and told to its span, and never reach the agent's answer", async (t) => {
  const h = harness(t);
  const requests = [{ method: "POST", url: "https://dev.example.com/api/orders", count: 2 }, { method: "DELETE", url: "https://dev.example.com/api/orders/1", count: 1 }];
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 3, devWriteRequests: requests };
  const attrs: Record<string, unknown> = {};
  const response = await new RunSpecUseCase(h.deps).run({ sessionId: "ses-1", agent: RUN_SPEC_FLOW_AGENT, path: "flows/a.spec.ts" }, undefined, { setAttrs: (a) => Object.assign(attrs, a) });
  assert.ok(response.ok);
  assert.deepEqual(h.capability.ledger[0]!.devWriteRequests, requests);
  assert.deepEqual(attrs["qayaba.tool.dev_write_requests"], ["POST https://dev.example.com/api/orders ×2", "DELETE https://dev.example.com/api/orders/1"]);
  assert.doesNotMatch(JSON.stringify(response), /api\/orders/);
});

test("the session requests kept apart from the writes are told to the call's span and charge nothing", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 0, sessionRequests: [{ method: "POST", url: "https://id.example.com/oauth/token", count: 4 }] };
  const attrs: Record<string, unknown> = {};
  const response = await new RunSpecUseCase(h.deps).run({ sessionId: "ses-1", agent: RUN_SPEC_FLOW_AGENT, path: "flows/a.spec.ts" }, undefined, { setAttrs: (a) => Object.assign(attrs, a) });
  assert.ok(response.ok);
  assert.deepEqual(attrs["qayaba.tool.dev_session_requests"], ["POST https://id.example.com/oauth/token ×4"]);
  assert.equal(attrs["qayaba.tool.dev_writes"], 0);
  assert.equal(response.report.budget.devWritesLeft, 5);
  assert.doesNotMatch(JSON.stringify(response), /oauth/);
});

test("a spec rewritten while the call ran is not recorded as a pass, whatever the run said", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 0 };
  h.deps.executor.execute = async (request) => {
    h.executed.push(request);
    /* The spec's bytes are the agent's to change: the sandboxed child is not, but the agent's own files are, and the ledger must name what ran. */
    h.write("flows/a.spec.ts", `${SPEC}// edited while it ran\n`);
    return h.next.result!;
  };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.notEqual(response.report.status, "passed");
  assert.notEqual(h.capability.ledger[0]!.status, "passed");
  assert.match(response.report.note ?? "", /changed while/);
});

test("a spec removed while the call ran is not recorded as a pass either", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 0 };
  h.deps.executor.execute = async (request) => {
    h.executed.push(request);
    rmSync(join(h.specDir, "flows", "a.spec.ts"));
    return h.next.result!;
  };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.notEqual(h.capability.ledger[0]!.status, "passed");
});

test("a call whose writes could not be counted is charged the whole write budget that was left, and says so", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "" };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(h.capability.ledger[0]!.devWrites, 5);
  assert.equal(response.report.budget.devWritesLeft, 0);
  assert.match(response.report.note ?? "", /could not be counted/);
  const next = await call(h, "flows/a.spec.ts");
  assert.ok(!next.ok && next.code === CLOSED_LOOP_REFUSAL.NO_WRITES, "the cap is spent, so the next call is refused");
});

test("a count that could not be made charges what was left after the writes already counted", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 2 };
  assert.ok((await call(h, "flows/a.spec.ts")).ok);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "" };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(h.capability.ledger[1]!.devWrites, 3);
});

test("a spec whose import of the fixtures is only in a comment is refused, since its writes could not be counted", async (t) => {
  const h = harness(t);
  h.write("flows/sneaky.spec.ts", '// import { test } from "../fixtures";\nimport { test } from "@playwright/test";\ntest("x", async () => {});\n');
  const response = await call(h, "flows/sneaky.spec.ts");
  assert.equal(response.ok, false);
  assert.equal(h.executed.length, 0);
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
  assert.equal(response.report.sessionLost, undefined);
});

test("a session that cannot be renewed is a lost session: said, flagged, and not evidence about the spec", async (t) => {
  const h = harness(t, { session: { renew: async () => false } });
  h.next.result = { verdict: "fail", cases: [{ name: "t", status: "fail", detail: "x", failureDom: "textbox: Password" }], logs: "" };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.sessionLost, true);
  assert.match(response.report.note ?? "", /session lost/i);
});

test("without a renewal port a login wall is a lost session too", async (t) => {
  const h = harness(t);
  delete h.deps.session;
  h.next.result = { verdict: "fail", cases: [{ name: "t", status: "fail", detail: "x", finalUrl: "https://dev.example/login" }], logs: "" };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.sessionLost, true);
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

test("a call that waited for the account runs for what the run has left when it gets it, not what it had left when it asked", async (t) => {
  let left = 60_000;
  const h = harness(t, { deadline: { remainingMs: () => left, describe: () => undefined } });
  let release!: () => void;
  const held = h.deps.lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const pending = call(h, "flows/a.spec.ts");
  await new Promise((r) => setImmediate(r));
  left = 40_000;
  release();
  await held;
  assert.ok((await pending).ok);
  assert.equal(h.executed[0]!.timeoutMs, 25_000);
});

test("a call that waited for the account until the run had no time left is refused and not spent", async (t) => {
  let left = 60_000;
  const h = harness(t, { deadline: { remainingMs: () => left, describe: () => undefined } });
  let release!: () => void;
  const held = h.deps.lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const pending = call(h, "flows/a.spec.ts");
  await new Promise((r) => setImmediate(r));
  left = 5_000;
  release();
  await held;
  const response = await pending;
  assert.ok(!response.ok && response.code === CLOSED_LOOP_REFUSAL.NO_TIME);
  assert.equal(h.executed.length, 0);
  assert.equal(h.capability.calls, 0);
  assert.equal(h.capability.pendingNamespace, undefined);
  assert.ok((await call(h, "flows/a.spec.ts")).ok === false, "the run still has no time, and the refusal is not a stuck call");
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

test("a call whose session ends is stopped: the executor is aborted, the call is spent and settled, and its namespace is still cleaned", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  h.deps.executor.execute = async (request) => {
    h.executed.push(request);
    await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { verdict: "infra-error", cases: [], logs: "playwright runner aborted by operator cancel — killed" };
  };
  const pending = new RunSpecUseCase(h.deps).run({ sessionId: "ses-1", agent: RUN_SPEC_FLOW_AGENT, path: "flows/a.spec.ts" }, controller.signal);
  await new Promise((r) => setImmediate(r));
  controller.abort();
  const response = await pending;
  assert.ok(response.ok && response.report.status === "error");
  assert.equal(h.capability.calls, 1);
  assert.equal(h.capability.pendingNamespace, undefined, "the call is settled, so the next call is not told another is running");
  assert.deepEqual(h.cleaned, ["run-1-rs1"]);
});

test("a call that waits for the account when its session ends leaves the queue without running", async (t) => {
  const h = harness(t);
  let release!: () => void;
  const held = h.deps.lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const controller = new AbortController();
  const pending = new RunSpecUseCase(h.deps).run({ sessionId: "ses-1", agent: RUN_SPEC_FLOW_AGENT, path: "flows/a.spec.ts" }, controller.signal);
  await new Promise((r) => setImmediate(r));
  controller.abort();
  const response = await pending;
  assert.ok(response.ok && response.report.status === "error");
  assert.equal(h.executed.length, 0);
  release();
  await held;
});

test("a call that gave up waiting for the account is not spent", async (t) => {
  const h = harness(t);
  let release!: () => void;
  const held = h.deps.lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const controller = new AbortController();
  const pending = new RunSpecUseCase(h.deps).run({ sessionId: "ses-1", agent: RUN_SPEC_FLOW_AGENT, path: "flows/a.spec.ts" }, controller.signal);
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await pending;
  assert.equal(h.capability.calls, 0);
  assert.equal(h.capability.pendingNamespace, undefined);
  release();
  await held;
});

const TOKEN = createHash("sha512").update("an-exfiltrated-session").digest().subarray(0, 36).toString("base64");

test("only a failing test is listed by title, the titles are bounded, and how many passed is a number", async (t) => {
  const h = harness(t);
  const cases: QaCase[] = [
    { name: "flows/a.spec.ts › passes one", status: "pass", durationMs: 12 },
    { name: `flows/a.spec.ts › ${"t".repeat(MAX_TITLE_CHARS * 2)}`, status: "fail", detail: "boom" },
    { name: "flows/a.spec.ts › passes two", status: "pass" },
  ];
  h.next.result = { verdict: "fail", cases, logs: "", devWrites: 0 };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.passedTests, 2);
  assert.equal(response.report.tests.length, 1);
  assert.ok(response.report.tests[0]!.title.length <= MAX_TITLE_CHARS);
  assert.doesNotMatch(JSON.stringify(response.report), /passes (one|two)/);
});

test("at most the first MAX_REPORTED_TESTS failing tests are listed, and the rest are counted", async (t) => {
  const h = harness(t);
  const cases: QaCase[] = Array.from({ length: MAX_REPORTED_TESTS + 5 }, (_, i) => ({ name: `flows/a.spec.ts › t${i}`, status: "fail" as const, detail: "x" }));
  h.next.result = { verdict: "fail", cases, logs: "", devWrites: 0 };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.tests.length, MAX_REPORTED_TESTS);
  assert.match(response.report.note ?? "", /first \d+ of \d+ failing/);
});

test("a long random-looking token in a failing test's title, error or page address is removed unless the page capture shows it", async (t) => {
  const h = harness(t);
  const cases: QaCase[] = [
    { name: `flows/a.spec.ts › leaks ${TOKEN}`, status: "fail", detail: `Error: sent ${TOKEN} out`, finalUrl: `https://dev.example/x/${TOKEN}`, failureDom: "heading: Orders" },
    { name: "flows/a.spec.ts › shown", status: "fail", detail: `Error: expected ${TOKEN}`, failureDom: `cell: ${TOKEN}` },
  ];
  h.next.result = { verdict: "fail", cases, logs: "", devWrites: 0 };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  const [leaking, shown] = response.report.tests;
  for (const text of [leaking!.title, leaking!.error!.message, leaking!.finalUrl!]) assert.doesNotMatch(text, new RegExp(TOKEN.replace(/[+/]/g, "\\$&")));
  assert.match(shown!.error!.message, new RegExp(TOKEN.replace(/[+/]/g, "\\$&")), "the page shows it, so the agent could read it anyway");
});

test("how long a failing test took is reported to the second, not to the millisecond", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "fail", cases: [{ name: "flows/a.spec.ts › slow", status: "fail", detail: "x", durationMs: 4_321 }], logs: "", devWrites: 0 };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.tests[0]!.durationMs, 4_000);
});

test("the ledger keeps the facts of each failing test: its page by pathname, the results it read, the server status, the runtime errors, whether the page had settled, and its error, redacted", async (t) => {
  const h = harness(t);
  h.next.result = {
    verdict: "fail",
    cases: [
      { name: "empty", status: "fail", detail: "Error: expected hunter2", finalUrl: "https://dev.example/shops/madrid?near=1#top", failureResultCount: 0, failureSettle: { inFlight: 2, treeStable: false } },
      { name: "server", status: "fail", detail: "x", httpStatus: 503, runtimeErrors: [{ type: "pageerror", text: "boom hunter2" }] },
      { name: "passes", status: "pass" },
    ],
    logs: "",
  };
  await call(h, "flows/a.spec.ts");
  assert.deepEqual(h.capability.ledger[0]!.failures, [
    { detail: "Error: expected [REDACTED]", path: "/shops/madrid", resultCount: 0, unsettled: true },
    { detail: "x", httpStatus: 503, runtimeErrors: [{ type: "pageerror", text: "boom [REDACTED]" }] },
  ]);
});

test("a call whose tests all passed keeps no failure facts", async (t) => {
  const h = harness(t);
  await call(h, "flows/a.spec.ts");
  assert.equal(h.capability.ledger[0]!.failures, undefined);
});

/* A call that was stopped (its session ended, its time ran out, it was cancelled) leaves the tests that began with the writes they had sent, counted by the runner from their ledgers. */
const INTERRUPTED = (devWrites: number | undefined, unfinishedTests?: number): SpecExecutionResult => ({
  verdict: "infra-error", cases: [], logs: "playwright runner timed out after 60000ms — killed",
  ...(devWrites !== undefined ? { devWrites } : {}), ...(unfinishedTests !== undefined ? { unfinishedTests } : {}),
});

function withRunLedger(t: TestContext, cap: number): { h: Harness; runWrites: RunDevWriteLedger } {
  const runWrites = new RunDevWriteLedger(cap);
  const capability = new RunSpecCapability({ runId: "run-1", limits: { ...LIMITS, maxDevWrites: cap }, expiresAtMs: Number.MAX_SAFE_INTEGER, now: () => 0, runWrites });
  capability.bindSession("ses-1");
  return { h: harness(t, { capability }), runWrites };
}

test("an interrupted call is charged exactly the writes its ledgers counted, says so, and the next call is admitted", async (t) => {
  const { h, runWrites } = withRunLedger(t, 5);
  h.next.result = INTERRUPTED(3, 1);
  const attrs: Record<string, unknown> = {};
  const first = await new RunSpecUseCase(h.deps).run({ sessionId: "ses-1", agent: RUN_SPEC_FLOW_AGENT, path: "flows/a.spec.ts" }, undefined, { setAttrs: (a) => Object.assign(attrs, a) });
  assert.ok(first.ok);
  assert.equal(runWrites.used, 3, "what the ledgers counted, not the run's whole remainder");
  assert.equal(first.report.budget.devWritesLeft, 2);
  assert.equal(attrs["qayaba.tool.dev_writes"], 3);
  assert.match(first.report.note ?? "", /1 test/);
  assert.doesNotMatch(first.report.note ?? "", /could not be counted/);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 1 };
  const second = await call(h, "flows/a.spec.ts");
  assert.ok(second.ok, "the writes left are still the run's to spend");
  assert.equal(runWrites.used, 4);
});

test("an interrupted call whose writes could not be counted still charges the run's whole remainder", async (t) => {
  const { h, runWrites } = withRunLedger(t, 5);
  h.next.result = INTERRUPTED(undefined);
  const first = await call(h, "flows/a.spec.ts");
  assert.ok(first.ok);
  assert.match(first.report.note ?? "", /could not be counted/);
  assert.equal(runWrites.left(), 0);
  const second = await call(h, "flows/a.spec.ts");
  assert.ok(!second.ok && second.code === CLOSED_LOOP_REFUSAL.NO_WRITES);
});

test("a call that sent only session requests charges the run nothing", async (t) => {
  const { h, runWrites } = withRunLedger(t, 5);
  h.next.result = { verdict: "pass", cases: [{ name: "t", status: "pass" }], logs: "", devWrites: 0, sessionRequests: [{ method: "POST", url: "https://id.example.com/oauth/token", count: 2 }] };
  assert.ok((await call(h, "flows/a.spec.ts")).ok);
  assert.equal(runWrites.used, 0);
});

const LOAD_SYNTAX = "SyntaxError: Unexpected token (12:5)\n\n  10 | test('x', async () => {\n> 12 |   await page.goto(\"/\"\n     |      ^";

test("a spec that did not load says so and gives each load error with its suite-relative place, redacted and bounded, instead of blaming the path or the grep", async (t) => {
  const h = harness(t);
  h.next.result = {
    verdict: "infra-error", cases: [], logs: "RAW STDOUT MUST NOT LEAK", devWrites: 0,
    loadErrors: [
      { message: `\u001b[31m${LOAD_SYNTAX}\u001b[39m\ntoken hunter2 in the source`, location: { file: "flows/a.spec.ts", line: 12, column: 5 } },
      { message: `Error: ${"y".repeat(MAX_ERROR_CHARS * 2)}` },
    ],
  };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.status, "error");
  const [syntax, long] = response.report.loadErrors ?? [];
  assert.match(syntax!.message, /Unexpected token/);
  assert.doesNotMatch(syntax!.message, /hunter2|\u001b/);
  assert.equal(syntax!.location, "e2e/flows/a.spec.ts:12:5");
  assert.ok(long!.message.length <= MAX_ERROR_CHARS);
  assert.equal(long!.location, undefined);
  assert.match(response.report.note ?? "", /did not load/i);
  assert.doesNotMatch(response.report.note ?? "", /path|grep/i);
  assert.doesNotMatch(JSON.stringify(response), /RAW STDOUT/);
  assert.equal(h.capability.calls, 1, "a load failure still spends its call");
});

test("a load error never carries a host path: a file outside the suite has no location and the suite's own roots are taken off the text", async (t) => {
  const h = harness(t);
  h.next.result = {
    verdict: "infra-error", cases: [], logs: "", devWrites: 0,
    loadErrors: [
      { message: `Error: Cannot find module './nope' imported from ${h.specDir}/flows/a.spec.ts`, location: { file: `${h.specDir}/flows/a.spec.ts`, line: 1 } },
      { message: "Error: boom", location: { file: "../../etc/secret.ts", line: 3 } },
    ],
  };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  const [first, second] = response.report.loadErrors ?? [];
  assert.equal(first!.location, undefined, "an absolute file is not trusted to be the suite's");
  assert.equal(second!.location, undefined);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(h.mirrorDir.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
});

test("at most MAX_REPORTED_LOAD_ERRORS load errors are listed, and the rest are counted", async (t) => {
  const h = harness(t);
  const loadErrors = Array.from({ length: MAX_REPORTED_LOAD_ERRORS + 3 }, (_, i) => ({ message: `Error: e${i}` }));
  h.next.result = { verdict: "infra-error", cases: [], logs: "", devWrites: 0, loadErrors };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.equal(response.report.loadErrors?.length, MAX_REPORTED_LOAD_ERRORS);
  assert.match(response.report.note ?? "", /first \d+ of \d+ load errors/);
});

test("a call where no test matched the grep still tells the generator to check the path and the grep", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "infra-error", cases: [], logs: "", devWrites: 0 };
  const response = await call(h, "flows/a.spec.ts", { grep: "no such title" });
  assert.ok(response.ok);
  assert.equal(response.report.status, "error");
  assert.equal(response.report.loadErrors, undefined);
  assert.match(response.report.note ?? "", /path/);
  assert.match(response.report.note ?? "", /grep/);
});

test("a call with no grep and no load error does not blame a grep that was never given", async (t) => {
  const h = harness(t);
  h.next.result = { verdict: "infra-error", cases: [], logs: "", devWrites: 0 };
  const response = await call(h, "flows/a.spec.ts");
  assert.ok(response.ok);
  assert.match(response.report.note ?? "", /no test ran/);
  assert.doesNotMatch(response.report.note ?? "", /grep/);
});
