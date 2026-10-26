/* A login whose child was refused hosts by the egress filter did not fail on the account or the app: it is an environmental precondition that names the hosts, whatever else could also explain the failure, and it never falls back to a second login. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSessionAdapter, type AuthSessionSpawnResult } from "@contexts/app-catalog/infrastructure/auth-session.adapter.ts";
import { AuthPreconditionError, PRECONDITION_KIND } from "@contexts/app-catalog/domain/auth-precondition.ts";
import { newSandboxReport, withExecScope } from "../../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";

import { scriptedLoginEvidence } from "../../../support/login-evidence.ts";

const STOCK_SEED = readFileSync(fileURLToPath(new URL("../../../../../config/e2e/auth.setup.ts", import.meta.url)), "utf8");
const AUTH = { kind: "form" as const, usernameEnv: "QA_USER", passwordEnv: "QA_PASS" };

/* A login child that the egress filter refuses `hosts` while it runs, the way the controller tells the run's sandbox report. */
function refusedChild(report: ReturnType<typeof newSandboxReport>, hosts: string[], result: AuthSessionSpawnResult): () => Promise<AuthSessionSpawnResult> {
  return async () => {
    for (const host of hosts) {
      if (!report.denied.includes(host)) report.denied.push(host);
      for (const watcher of report.watchers ?? []) watcher(host);
    }
    return result;
  };
}

function adapterWith(spawn: AuthSessionAdapterSpawn, authored: boolean): { adapter: AuthSessionAdapter; specDir: string } {
  const specDir = mkdtempSync(join(tmpdir(), "auth-egress-"));
  if (authored) writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
  return { adapter: new AuthSessionAdapter({ env: { QA_USER: "alice", QA_PASS: "s3cret-pass" }, authDir: mkdtempSync(join(tmpdir(), "auth-dir-")), spawnSetup: spawn }), specDir };
}
type AuthSessionAdapterSpawn = (specDir: string, env: Record<string, string>, signal?: AbortSignal) => Promise<AuthSessionSpawnResult>;

function prepareIn(report: ReturnType<typeof newSandboxReport>, run: () => Promise<unknown>): Promise<unknown> {
  return withExecScope({ runId: "r", workDir: "/tmp/r", egress: { dev: [], install: [] }, report }, run);
}

test("an app's own login that fails while its child was refused a host ends as an egress precondition naming the host and where to declare it", async () => {
  const report = newSandboxReport();
  const { adapter, specDir } = adapterWith(async (...args) => refusedChild(report, ["idp.example.test"], { exitCode: 1, logs: "waiting for username" })(), true);
  const failure = await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })).catch((err: unknown) => err);
  assert.ok(failure instanceof AuthPreconditionError);
  assert.equal(failure.kind, PRECONDITION_KIND.EGRESS_DENIED);
  assert.match(failure.note, /idp\.example\.test/);
  assert.match(failure.note, /dev\.allowedOrigins/);
  assert.ok(!failure.note.includes("s3cret-pass"));
});

test("a stock login that cannot sign in while its child was refused a host does not fall back to the agent rewriting it", async () => {
  const report = newSandboxReport();
  const specDir = mkdtempSync(join(tmpdir(), "auth-egress-"));
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "alice", QA_PASS: "p" },
    authDir: mkdtempSync(join(tmpdir(), "auth-dir-")),
    spawnSetup: refusedChild(report, ["idp.example.test"], { exitCode: 1, logs: "" }),
  });
  const failure = await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })).catch((err: unknown) => err);
  assert.ok(failure instanceof AuthPreconditionError);
  assert.equal(failure.kind, PRECONDITION_KIND.EGRESS_DENIED);
});

test("a host the run was refused before the login, met again by the login, is still the login's", async () => {
  const report = newSandboxReport();
  report.denied.push("idp.example.test");
  const { adapter, specDir } = adapterWith(refusedChild(report, ["idp.example.test"], { exitCode: 1, logs: "" }), true);
  const failure = await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })).catch((err: unknown) => err);
  assert.ok(failure instanceof AuthPreconditionError && failure.kind === PRECONDITION_KIND.EGRESS_DENIED);
});

test("a host refused to something else before the login does not turn the login's own failure into an egress one", async () => {
  const report = newSandboxReport();
  report.denied.push("registry.example.test");
  const { adapter, specDir } = adapterWith(async () => ({ exitCode: 1, logs: "still on login" }), true);
  await assert.rejects(() => prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })), /still on login/);
});

test("a login that signs in is the session even when hosts were refused on the way", async () => {
  const report = newSandboxReport();
  const { adapter, specDir } = adapterWith(async (_dir, env) => {
    await refusedChild(report, ["tracker.example.test"], { exitCode: 0, logs: "" })();
    writeFileSync(env.PW_STORAGE_STATE!, "{\"cookies\":[]}");
    return { exitCode: 0, logs: "" };
  }, true);
  const session = (await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH }))) as { storageStatePath?: string };
  assert.ok(session.storageStatePath);
});

test("a positively evidenced login failure keeps its kind and its note also names the hosts the filter refused", async () => {
  const report = newSandboxReport();
  const specDir = mkdtempSync(join(tmpdir(), "auth-egress-"));
  writeFileSync(join(specDir, "auth.setup.ts"), STOCK_SEED);
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "alice", QA_PASS: "s3cret-pass" },
    authDir: mkdtempSync(join(tmpdir(), "auth-dir-")),
    spawnSetup: async () => { throw new Error("the seed must not run after a submitted login"); },
    discovery: {
      discoverLogin: async () => {
        for (const watcher of report.watchers ?? []) watcher("cdn.example.test");
        return scriptedLoginEvidence();
      },
      redact: (text) => text,
    },
  });
  const failure = await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })).catch((err: unknown) => err);
  assert.ok(failure instanceof AuthPreconditionError);
  assert.equal(failure.kind, PRECONDITION_KIND.CREDENTIALS_REJECTED);
  assert.match(failure.note, /cdn\.example\.test/);
  assert.match(failure.note, /dev\.allowedOrigins/);
});

/* Telemetry, analytics and the like are refused on every page of the app, so the filter's refusal of them says nothing of why a login failed: the app's config lists the origins it leaves blocked on purpose. */
function adapterBlocking(spawn: AuthSessionAdapterSpawn, blocked: (host: string) => boolean): { adapter: AuthSessionAdapter; specDir: string } {
  const specDir = mkdtempSync(join(tmpdir(), "auth-egress-"));
  writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
  return { adapter: new AuthSessionAdapter({ env: { QA_USER: "alice", QA_PASS: "s3cret-pass" }, authDir: mkdtempSync(join(tmpdir(), "auth-dir-")), spawnSetup: spawn, intentionallyBlocked: blocked }), specDir };
}
const isTelemetry = (host: string): boolean => host.endsWith(".telemetry.example.test");

test("a login that fails while only hosts the app leaves blocked on purpose were refused is the login's own failure, not an egress one", async () => {
  const report = newSandboxReport();
  const { adapter, specDir } = adapterBlocking(async () => {
    await refusedChild(report, ["ingest.telemetry.example.test"], { exitCode: 1, logs: "" })();
    return { exitCode: 1, logs: "button never became visible" };
  }, isTelemetry);
  await assert.rejects(() => prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })), /button never became visible/);
});

test("a failed login names the hosts that count, not the ones left blocked on purpose", async () => {
  const report = newSandboxReport();
  const { adapter, specDir } = adapterBlocking(refusedChild(report, ["ingest.telemetry.example.test", "fonts.example.test"], { exitCode: 1, logs: "" }), isTelemetry);
  const failure = await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })).catch((err: unknown) => err);
  assert.ok(failure instanceof AuthPreconditionError);
  assert.equal(failure.kind, PRECONDITION_KIND.EGRESS_DENIED);
  assert.match(failure.note, /fonts\.example\.test/);
  assert.doesNotMatch(failure.note, /telemetry\.example\.test/);
  assert.match(failure.note, /1 host\(s\)/);
});

test("the note of an egress failure says where a host that should stay blocked is declared", async () => {
  const report = newSandboxReport();
  const { adapter, specDir } = adapterWith(refusedChild(report, ["fonts.example.test"], { exitCode: 1, logs: "" }), true);
  const failure = await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })).catch((err: unknown) => err);
  assert.ok(failure instanceof AuthPreconditionError);
  assert.match(failure.note, /dev\.blockedOrigins/);
});

test("hosts left blocked on purpose are also left out of the hosts a positively evidenced failure adds to its note", async () => {
  const report = newSandboxReport();
  const specDir = mkdtempSync(join(tmpdir(), "auth-egress-"));
  writeFileSync(join(specDir, "auth.setup.ts"), STOCK_SEED);
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "alice", QA_PASS: "s3cret-pass" },
    authDir: mkdtempSync(join(tmpdir(), "auth-dir-")),
    spawnSetup: async () => { throw new Error("the seed must not run after a submitted login"); },
    intentionallyBlocked: isTelemetry,
    discovery: {
      discoverLogin: async () => {
        for (const watcher of report.watchers ?? []) { watcher("ingest.telemetry.example.test"); watcher("cdn.example.test"); }
        return scriptedLoginEvidence();
      },
      redact: (text) => text,
    },
  });
  const failure = await prepareIn(report, () => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: AUTH })).catch((err: unknown) => err);
  assert.ok(failure instanceof AuthPreconditionError);
  assert.equal(failure.kind, PRECONDITION_KIND.CREDENTIALS_REJECTED);
  assert.match(failure.note, /cdn\.example\.test/);
  assert.doesNotMatch(failure.note, /telemetry\.example\.test/);
});
