import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowserPortAdapter, type AgentBrowserPortAdapterDeps } from "@contexts/agent-tools/infrastructure/adapters/agent-browser-port.adapter.ts";
import { AgentBrowserRegistry } from "@contexts/agent-tools/infrastructure/agent-browser-registry.ts";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { BrowserActionError, type AgentBrowserHostPort, type BrowserAction, type BrowserCallOptions, type PageState } from "@contexts/test-execution/application/index.ts";
import { newSandboxReport, withExecScope } from "../../../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";
import type { AgentBrowserOpenInput } from "@contexts/agent-tools/application/index.ts";
import type { SessionMaterial } from "@contexts/test-execution/infrastructure/agent-browser/playwright-types.ts";

const BASE = "https://dev.example.com";
const OPEN: AgentBrowserOpenInput = { runId: "run-9", app: "demo", mode: "diff", specDir: "/mirror/e2e" };
const PAGE: PageState = { url: `${BASE}/orders`, title: "Orders", snapshot: "- heading [ref=e1]", passwordFieldVisible: false, requestedPath: "/orders", blocked: [], notes: [] };

class FakeHost implements AgentBrowserHostPort {
  readonly performed: { sessionId: string; action: BrowserAction; options: BrowserCallOptions }[] = [];
  released: string[] = [];
  resets = 0;
  closed = 0;
  page: () => Promise<PageState> | PageState = () => PAGE;
  async perform(sessionId: string, action: BrowserAction, options: BrowserCallOptions): Promise<PageState> {
    this.performed.push({ sessionId, action, options });
    return this.page();
  }
  async release(sessionId: string): Promise<void> { this.released.push(sessionId); }
  async reset(): Promise<void> { this.resets += 1; }
  async close(): Promise<void> { this.closed += 1; }
}

function rig(over: { enabled?: boolean; canCall?: boolean; material?: SessionMaterial; renew?: () => Promise<boolean> } = {}) {
  const registry = new AgentBrowserRegistry();
  const host = new FakeHost();
  const seen: { redacted?: string } = {};
  const prepared: { specDir: string; phase: string }[] = [];
  const deps: AgentBrowserPortAdapterDeps = {
    registry,
    setting: { enabled: over.enabled ?? true, denyRoutes: ["/admin/**"], allowMutating: [] },
    generatorRuntimeCanCall: () => over.canCall ?? true,
    baseUrl: BASE,
    material: () => over.material ?? { storageState: { cookies: [{ name: "sid" }], origins: [] } },
    launcher: { launch: async () => { throw new Error("the fake host never launches"); } },
    createHost: () => host,
    account: "demo/user",
    lock: new AccountLock(),
    redact: (text) => redactByValue(text),
    ...(over.renew ? { authSession: { prepare: async (req: { specDir: string; phase: string }) => { prepared.push({ specDir: req.specDir, phase: req.phase }); if (!(await over.renew!())) throw new Error("login failed"); return { unauthored: false }; } }, authContext: { baseUrl: BASE } } : {}),
  };
  return { deps, registry, host, seen, prepared };
}

const call = (registry: AgentBrowserRegistry, sessionId: string, url = "/orders") => registry.find(sessionId)!.call({ sessionId, agent: "qa-generator", action: "navigate", url });

test("a disabled app is not granted the browser, and the run's own choice overrides the app's", async () => {
  const off = rig({ enabled: false });
  assert.equal(await new AgentBrowserPortAdapter(off.deps).open(OPEN), undefined);
  assert.equal(off.registry.size, 0);
  assert.ok(await new AgentBrowserPortAdapter(rig({ enabled: false }).deps).open({ ...OPEN, enabled: true }));
  assert.equal(await new AgentBrowserPortAdapter(rig({ enabled: true }).deps).open({ ...OPEN, enabled: false }), undefined);
});

test("a generator on a runtime that cannot call a custom tool is not granted the browser", async () => {
  const r = rig({ canCall: false });
  assert.equal(await new AgentBrowserPortAdapter(r.deps).open(OPEN), undefined);
  assert.equal(r.registry.size, 0);
});

test("a run with no saved session has nothing to authenticate with and is not granted the browser", async () => {
  const r = rig({ material: {} });
  assert.equal(await new AgentBrowserPortAdapter(r.deps).open(OPEN), undefined);
  assert.equal(r.registry.size, 0);
});

test("a run whose only credential is a client certificate is granted the browser", async () => {
  const r = rig({ material: { clientCertificate: { origin: BASE, pfx: Buffer.from("x") } } });
  assert.ok(await new AgentBrowserPortAdapter(r.deps).open(OPEN));
});

test("an open browser states its limits and waits for an authoring session", async () => {
  const r = rig();
  const handle = await new AgentBrowserPortAdapter(r.deps).open(OPEN);
  assert.ok(handle && handle.limits.maxCalls > 0);
  assert.equal(r.registry.size, 1);
  assert.equal(r.registry.find("ses-1"), undefined);
});

test("only an authoring session of the run is served, through the run's guard", async () => {
  const r = rig();
  await new AgentBrowserPortAdapter(r.deps).open(OPEN);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: "qa-generator" });
  r.registry.bindSession({ sessionId: "ses-2", runId: "run-9", agent: "qa-reviewer" });
  assert.equal(r.registry.find("ses-2"), undefined);
  const ok = await call(r.registry, "ses-1");
  assert.equal(ok.ok, true);
  assert.equal(r.host.performed[0]?.sessionId, "ses-1");
  const denied = await call(r.registry, "ses-1", "/admin/users");
  assert.equal(denied.ok, false, "the app's denied routes are the guard's");
  assert.equal(r.host.performed.length, 1);
});

test("the guard is built from the origins of the run's scope", async () => {
  const r = rig();
  await withExecScope({ runId: "run-9", workDir: "/tmp/x", egress: { dev: [BASE, "https://api.example.com"], install: [] }, report: newSandboxReport() }, async () => {
    await new AgentBrowserPortAdapter(r.deps).open(OPEN);
  });
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: "qa-generator" });
  const other = await call(r.registry, "ses-1", "https://api.example.com/health");
  assert.equal(other.ok, true);
  const undeclared = await call(r.registry, "ses-1", "https://evil.example.org/");
  assert.equal(undeclared.ok, false);
});

test("a call made from outside the run still runs in the run's scope, with its secrets taken out of the answer", async () => {
  const r = rig();
  r.host.page = () => ({ ...PAGE, title: "token hunter2-secret" });
  const scope = createRunSecretScope();
  scope.addAccountSecrets(["hunter2-secret"]);
  await withRunSecretScope(scope, async () => {
    await new AgentBrowserPortAdapter(r.deps).open(OPEN);
  });
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: "qa-generator" });
  const res = await call(r.registry, "ses-1");
  assert.doesNotMatch(JSON.stringify(res), /hunter2-secret/);
});

test("an ended session closes its page and stops its call; the browser stays for the others", async () => {
  const r = rig();
  await new AgentBrowserPortAdapter(r.deps).open(OPEN);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: "qa-generator" });
  let observed: AbortSignal | undefined;
  r.host.page = async () => { observed = r.host.performed.at(-1)!.options.signal; await new Promise((resolve) => setTimeout(resolve, 20)); throw new BrowserActionError("cancelled"); };
  const pending = call(r.registry, "ses-1");
  await new Promise((resolve) => setImmediate(resolve));
  r.registry.unbindSession("ses-1");
  await pending;
  assert.equal(observed?.aborted, true);
  assert.deepEqual(r.host.released, ["ses-1"]);
  assert.equal(r.host.closed, 0);
});

test("a lost session is renewed through the auth port and the browser starts over", async (t) => {
  const specDir = mkdtempSync(join(tmpdir(), "agent-browser-spec-"));
  t.after(() => rmSync(specDir, { recursive: true, force: true }));
  writeFileSync(join(specDir, "auth.setup.ts"), "// the login the run opened with\n");
  let renewals = 0;
  const r = rig({ renew: async () => { renewals += 1; return true; } });
  r.host.page = () => ({ ...PAGE, url: `${BASE}/login` });
  const handle = await new AgentBrowserPortAdapter(r.deps).open({ ...OPEN, specDir });
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: "qa-generator" });
  const res = await call(r.registry, "ses-1");
  assert.equal(res.ok, false);
  assert.equal(renewals, 1);
  assert.deepEqual(r.prepared, [{ specDir, phase: "pre-execute" }], "the login is prepared again for this run's suite");
  assert.equal(r.host.resets, 1);
  assert.deepEqual({ ...handle!.signals() }, { calls: 1, blocks: 0, invalidations: 1, renewals: 1 });
});

test("a lost session is not renewed with a login the agent rewrote while it authored", async (t) => {
  const specDir = mkdtempSync(join(tmpdir(), "agent-browser-spec-"));
  t.after(() => rmSync(specDir, { recursive: true, force: true }));
  writeFileSync(join(specDir, "auth.setup.ts"), "// the login the run opened with\n");
  const r = rig({ renew: async () => true });
  r.host.page = () => ({ ...PAGE, url: `${BASE}/login` });
  await new AgentBrowserPortAdapter(r.deps).open({ ...OPEN, specDir });
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: "qa-generator" });
  writeFileSync(join(specDir, "auth.setup.ts"), "// rewritten by the agent\n");
  await call(r.registry, "ses-1");
  assert.deepEqual(r.prepared, []);
});

test("closing revokes the right, forgets the sessions and stops the browser, once", async () => {
  const r = rig();
  const handle = await new AgentBrowserPortAdapter(r.deps).open(OPEN);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: "qa-generator" });
  const live = r.registry.find("ses-1")!;
  await handle!.close();
  await handle!.close();
  assert.equal(r.registry.size, 0);
  assert.equal(r.registry.find("ses-1"), undefined);
  assert.equal(r.host.closed, 1);
  const refused = await live.call({ sessionId: "ses-1", agent: "qa-generator", action: "snapshot" });
  assert.equal(refused.ok === false && refused.code, "revoked");
});

test("a flow's share of the browser's calls is granted through the handle, and its sidekick's calls stop at it while the generator's go on", async () => {
  const r = rig();
  const handle = (await new AgentBrowserPortAdapter(r.deps).open(OPEN))!;
  handle.grantShare("flow-a", 1);
  r.registry.bindSession({ sessionId: "side", runId: "run-9", agent: "qa-sidekick", delegationId: "flow-a" });
  r.registry.bindSession({ sessionId: "gen", runId: "run-9", agent: "qa-generator" });
  const sidekickCall = () => r.registry.find("side")!.call({ sessionId: "side", agent: "qa-sidekick", action: "navigate", url: "/orders" });
  assert.equal((await sidekickCall()).ok, true);
  const second = await sidekickCall();
  assert.equal(second.ok, false);
  assert.equal(!second.ok ? second.code : "", "no-calls");
  assert.equal((await call(r.registry, "gen")).ok, true);
  assert.equal(r.host.performed.filter((p) => p.sessionId === "side").length, 1, "the refused call never reached the browser");
});

