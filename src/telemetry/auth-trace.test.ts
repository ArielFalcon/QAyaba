/* Login attempts and suite-store calls as spans under the open phase, over the real telemetry adapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSessionAdapter, type AuthSessionAdapterDeps } from "../../qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter";
import { AuthPreconditionError, PRECONDITION_KIND } from "../../qa-engine/src/contexts/qa-run-orchestration/domain/auth-precondition";
import { TracedSuiteStore, classifySkipReason, SKIP_CLASS } from "../../qa-engine/src/contexts/qa-run-orchestration/infrastructure/adapters/suite-store-trace";
import { SKIP_REASON } from "@kernel/ports/suite-store.port";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { DEMOTE_REASON, classifyDemoteReason, type SuiteStorePort } from "@kernel/ports/suite-store.port";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { AUTH_MATERIAL_FILES } from "../../qa-engine/src/shared-infrastructure/process-sandbox/auth-session-env";
import { traceHarness } from "./trace-harness";

const REQ = { specDir: "/nonexistent/e2e", baseUrl: "https://dev.example.com", auth: { kind: "form" as const, usernameEnv: "U", passwordEnv: "P" }, phase: "pre-generate" as const };

function fixture(over: Partial<AuthSessionAdapterDeps> & { telemetry?: TelemetryPort } = {}) {
  const h = traceHarness();
  const authDir = mkdtempSync(join(tmpdir(), "auth-trace-"));
  const scope: RunScope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport() };
  const phase = h.telemetry.startSpan("qayaba.phase.setup");
  scope.telemetry = { parent: () => phase.context() };
  const adapter = new AuthSessionAdapter({
    env: { U: "alice", P: "correct-horse-battery" },
    authDir,
    spawnSetup: async () => {
      writeFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), JSON.stringify({ cookies: [], origins: [] }));
      return { exitCode: 0, logs: "" };
    },
    telemetry: h.telemetry,
    ...over,
  });
  return { h, scope, phase, adapter, authDir, dispose: () => rmSync(authDir, { recursive: true, force: true }) };
}

test("a login that signs in is one span under the open phase with its method, attempt number and outcome", async () => {
  const t = fixture();
  try {
    await withExecScope(t.scope, () => t.adapter.prepare(REQ));
    t.phase.end();
    const login = t.h.only("qayaba.auth.login");
    assert.equal(login.parentSpanContext?.spanId, t.phase.context().spanId);
    assert.equal(login.attributes["qayaba.auth.method"], "seed");
    assert.equal(login.attributes["qayaba.auth.attempt"], 1);
    assert.equal(login.attributes["qayaba.auth.outcome"], "authenticated");
    assert.equal(login.attributes["qayaba.auth.restored"], false);
    assert.deepEqual(t.h.measurements.filter((m) => m.name === "qayaba.auth.attempts").map((m) => m.attrs), [{ "qayaba.auth.outcome": "authenticated" }]);
    assert.deepEqual(t.h.unended(), []);
  } finally {
    t.dispose();
  }
});

test("each attempt of a run is a span of its own, numbered across the run", async () => {
  const t = fixture({
    discovery: { discoverLogin: async () => ({ crashed: true, attempted: false }), redact: (x) => x },
  });
  try {
    await withExecScope(t.scope, () => t.adapter.prepare(REQ));
    const attempts = t.h.named("qayaba.auth.login").map((s) => [s.attributes["qayaba.auth.attempt"], s.attributes["qayaba.auth.method"], s.attributes["qayaba.auth.outcome"]]);
    assert.deepEqual(attempts, [[1, "discovery", "inconclusive"], [2, "seed", "authenticated"]]);
  } finally {
    t.dispose();
  }
});

test("a seed that did not sign in before generation is a setup failure, not an error", async () => {
  const t = fixture({ spawnSetup: async () => ({ exitCode: 1, logs: "boom" }) });
  try {
    const session = await withExecScope(t.scope, () => t.adapter.prepare(REQ));
    assert.equal(session.unauthored, true);
    const login = t.h.only("qayaba.auth.login");
    assert.equal(login.attributes["qayaba.auth.outcome"], "setup-failed");
    assert.equal(login.status.code, 0);
  } finally {
    t.dispose();
  }
});

test("a login evidenced to fail is a precondition attempt with its kind", async () => {
  const t = fixture({
    discovery: {
      discoverLogin: async () => {
        throw new AuthPreconditionError(PRECONDITION_KIND.CREDENTIALS_REJECTED, "rejected", 5);
      },
      redact: (x) => x,
    },
  });
  try {
    await assert.rejects(withExecScope(t.scope, () => t.adapter.prepare(REQ)), AuthPreconditionError);
    const login = t.h.only("qayaba.auth.login");
    assert.equal(login.attributes["qayaba.auth.outcome"], "precondition");
    assert.equal(login.attributes["qayaba.auth.precondition_kind"], "credentials-rejected");
    assert.equal(login.status.code, 0);
  } finally {
    t.dispose();
  }
});

test("hosts the egress filter refused during an attempt are listed, with the ones the app blocks on purpose apart", async () => {
  const t = fixture({
    intentionallyBlocked: (host) => host === "analytics.example.net",
    spawnSetup: async () => {
      for (const watcher of t.scope.report.watchers ?? []) {
        watcher("cdn.thirdparty.test");
        watcher("analytics.example.net");
      }
      return { exitCode: 1, logs: "" };
    },
  });
  try {
    await withExecScope(t.scope, () => t.adapter.prepare(REQ)).catch(() => undefined);
    const login = t.h.only("qayaba.auth.login");
    assert.deepEqual(login.attributes["qayaba.egress.denied"], ["cdn.thirdparty.test"]);
    assert.deepEqual(login.attributes["qayaba.egress.denied_intentional"], ["analytics.example.net"]);
  } finally {
    t.dispose();
  }
});

test("a login restored from the suite store, and one demoted earlier in the run, say so on their attempts", async () => {
  const h = traceHarness();
  let restoredAuth = true;
  const inner: SuiteStorePort = {
    restore: async () => ({ restored: 3, trackedWins: 1, overlaid: 2, authRestored: restoredAuth }),
    fingerprint: async () => new Map(),
    capture: async () => ({ entries: 5, admitted: 2, dropped: 1, skipped: [{ path: "a", reason: SKIP_REASON.CHANGED_AFTER_RUN }, { path: "b", reason: "the path is a link" }] }),
    demoteAuth: async () => {},
  };
  const store = new TracedSuiteStore(inner, h.telemetry);
  const authDir = mkdtempSync(join(tmpdir(), "auth-trace-"));
  const scope: RunScope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport() };
  const phase = h.telemetry.startSpan("qayaba.phase.setup");
  scope.telemetry = { parent: () => phase.context() };
  const adapter = new AuthSessionAdapter({
    env: { U: "alice", P: "correct-horse-battery" },
    authDir,
    spawnSetup: async () => {
      writeFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), "{}");
      return { exitCode: 0, logs: "" };
    },
    telemetry: h.telemetry,
  });
  try {
    await withExecScope(scope, async () => {
      await store.restore({ mirrorDir: "/m", specDir: "/m/e2e" });
      await adapter.prepare(REQ);
      await store.demoteAuth({ mirrorDir: "/m", specDir: "/m/e2e" }, DEMOTE_REASON.LOGIN_DID_NOT_SIGN_IN);
      restoredAuth = false;
      await adapter.prepare(REQ);
      await store.capture({ mirrorDir: "/m", specDir: "/m/e2e", runId: "r", sha: "abc", executedGreen: new Map() });
    });
    phase.end();
    const logins = h.named("qayaba.auth.login");
    assert.equal(logins[0]!.attributes["qayaba.auth.restored"], true);
    assert.equal(logins[0]!.attributes["qayaba.auth.demoted"], undefined);
    assert.equal(logins[1]!.attributes["qayaba.auth.restored"], false);
    assert.equal(logins[1]!.attributes["qayaba.auth.demoted"], true);
    assert.equal(logins[1]!.attributes["qayaba.auth.demoted_reason"], "login-did-not-sign-in");

    const restore = h.only("qayaba.suite_store.restore");
    assert.equal(restore.parentSpanContext?.spanId, phase.context().spanId);
    assert.deepEqual([restore.attributes["qayaba.suite_store.restored"], restore.attributes["qayaba.suite_store.overlaid"], restore.attributes["qayaba.suite_store.tracked_wins"], restore.attributes["qayaba.suite_store.auth_restored"]], [3, 2, 1, true]);
    const capture = h.only("qayaba.suite_store.capture");
    assert.deepEqual([capture.attributes["qayaba.suite_store.entries"], capture.attributes["qayaba.suite_store.admitted"], capture.attributes["qayaba.suite_store.dropped"], capture.attributes["qayaba.suite_store.skipped"]], [5, 2, 1, 2]);
    assert.deepEqual(capture.attributes["qayaba.suite_store.skip_reasons"], ["changed-after-run", "unreadable"]);
    assert.equal(h.only("qayaba.suite_store.demote").attributes["qayaba.suite_store.reason"], "login-did-not-sign-in");
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("a skip reason becomes a member of a closed set, whatever the store or the reader said", () => {
  assert.equal(classifySkipReason(SKIP_REASON.SESSION_STATE), "login-session");
  assert.equal(classifySkipReason(SKIP_REASON.NOT_VERIFIED_LOGIN), "login-not-verified");
  assert.equal(classifySkipReason(SKIP_REASON.VANISHED), "vanished");
  assert.equal(classifySkipReason("anything the confined reader said"), "unreadable");
  for (const reason of [SKIP_REASON.SESSION_STATE, "x"]) assert.ok(SKIP_CLASS.includes(classifySkipReason(reason)));
});

test("a demotion reason in any other words is exported as other, never as free text", async () => {
  assert.equal(classifyDemoteReason("some words with a secret hunter2"), "other");
  const h = traceHarness();
  const store = new TracedSuiteStore({ restore: async () => ({ restored: 0, trackedWins: 0, overlaid: 0, authRestored: false }), fingerprint: async () => new Map(), capture: async () => ({ entries: 0, admitted: 0, dropped: 0, skipped: [] }), demoteAuth: async () => {} }, h.telemetry);
  await store.demoteAuth({ mirrorDir: "/m", specDir: "/m/e2e" }, "some words with a secret hunter2");
  assert.equal(h.only("qayaba.suite_store.demote").attributes["qayaba.suite_store.reason"], "other");
});

test("a store call that fails is an error on its span and the failure goes on", async () => {
  const h = traceHarness();
  const store = new TracedSuiteStore({ restore: async () => { throw new Error("disk gone"); }, fingerprint: async () => new Map(), capture: async () => ({ entries: 0, admitted: 0, dropped: 0, skipped: [] }), demoteAuth: async () => {} }, h.telemetry);
  await assert.rejects(store.restore({ mirrorDir: "/m", specDir: "/m/e2e" }), /disk gone/);
  assert.equal(h.only("qayaba.suite_store.restore").status.code, 2);
});

test("a login and a store traced by a port that throws behave exactly as untraced ones", async () => {
  const t = fixture({ telemetry: new ThrowingTelemetry() });
  try {
    const session = await withExecScope(t.scope, () => t.adapter.prepare(REQ));
    assert.equal(session.unauthored, false);
    assert.ok(session.storageStatePath);
    const store = new TracedSuiteStore({ restore: async () => ({ restored: 1, trackedWins: 0, overlaid: 0, authRestored: false }), fingerprint: async () => new Map(), capture: async () => ({ entries: 0, admitted: 0, dropped: 0, skipped: [] }), demoteAuth: async () => {} }, new ThrowingTelemetry());
    assert.deepEqual(await store.restore({ mirrorDir: "/m", specDir: "/m/e2e" }), { restored: 1, trackedWins: 0, overlaid: 0, authRestored: false });
  } finally {
    t.dispose();
  }
});
