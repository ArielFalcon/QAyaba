import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { AgentBrowserCapability, AGENT_BROWSER_REFUSAL } from "@contexts/test-execution/domain/agent-browser-capability.ts";
import { createRouteGuard } from "@contexts/test-execution/domain/agent-browser-route-guard.ts";
import { AgentBrowserUseCase, MAX_SNAPSHOT_CHARS, type AgentBrowserRequest } from "@contexts/test-execution/application/agent-browser.use-case.ts";
import { BrowserActionError, type AgentBrowserHostPort, type BrowserAction, type PageState } from "@contexts/test-execution/application/ports/agent-browser.ports.ts";
import { DEFAULT_AGENT_BROWSER_LIMITS } from "@kernel/agent-browser.ts";

const BASE = "https://dev.example.com";

function page(over: Partial<PageState> = {}): PageState {
  return { url: `${BASE}/orders`, title: "Orders", snapshot: "- heading \"Orders\" [ref=e1]", passwordFieldVisible: false, requestedPath: "/orders", blocked: [], notes: [], ...over };
}

class FakeHost implements AgentBrowserHostPort {
  readonly calls: { sessionId: string; action: BrowserAction }[] = [];
  resets = 0;
  closed = 0;
  next: () => Promise<PageState> | PageState = () => page();
  async perform(sessionId: string, action: BrowserAction): Promise<PageState> {
    this.calls.push({ sessionId, action });
    return this.next();
  }
  async reset(): Promise<void> { this.resets += 1; }
  async close(): Promise<void> { this.closed += 1; }
}

function setup(over: { host?: FakeHost; lock?: AccountLock; renew?: (() => Promise<boolean>) | undefined; limits?: Partial<typeof DEFAULT_AGENT_BROWSER_LIMITS>; leaseWait?: AbortController; denyRoutes?: string[]; now?: () => number; expiresAtMs?: number } = {}) {
  const host = over.host ?? new FakeHost();
  const capability = new AgentBrowserCapability({ runId: "r1", limits: { ...DEFAULT_AGENT_BROWSER_LIMITS, ...over.limits }, expiresAtMs: over.expiresAtMs ?? 1_000_000, now: over.now ?? (() => 0) });
  capability.bindSession("s1");
  const lock = over.lock ?? new AccountLock();
  const useCase = new AgentBrowserUseCase({
    capability,
    host,
    baseUrl: BASE,
    guard: createRouteGuard({ origins: [BASE], denyRoutes: over.denyRoutes ?? ["/admin/**"], allowMutating: [] }),
    account: "app/user",
    lock,
    ...(over.renew !== undefined ? { session: { renew: over.renew } } : {}),
    redact: (text) => text.replaceAll("hunter2", "[REDACTED]"),
    leaseWaitSignal: () => over.leaseWait?.signal ?? new AbortController().signal,
  });
  return { host, capability, lock, useCase };
}

const nav = (url: string, over: Partial<AgentBrowserRequest> = {}): AgentBrowserRequest => ({ sessionId: "s1", agent: "qa-generator", action: "navigate", url, ...over }) as AgentBrowserRequest;

test("a session the orchestrator did not bind, or a role that does not author, gets nothing and the browser is not touched", async () => {
  const { host, useCase } = setup();
  const unknown = await useCase.call({ ...nav("/orders"), sessionId: "other" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, AGENT_BROWSER_REFUSAL.UNKNOWN_SESSION);
  const wrong = await useCase.call({ ...nav("/orders"), agent: "qa-reviewer" });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.code, AGENT_BROWSER_REFUSAL.WRONG_AGENT);
  assert.equal(host.calls.length, 0);
});

test("a revoked capability and an expired one refuse every call", async () => {
  const revoked = setup();
  revoked.capability.revoke();
  const r = await revoked.useCase.call(nav("/orders"));
  assert.equal(r.ok === false && r.code, AGENT_BROWSER_REFUSAL.REVOKED);
  let clock = 0;
  const expiring = setup({ now: () => clock, expiresAtMs: 100 });
  clock = 100;
  const e = await expiring.useCase.call(nav("/orders"));
  assert.equal(e.ok === false && e.code, AGENT_BROWSER_REFUSAL.EXPIRED);
});

test("a navigation resolves a path against the app's base address and returns the page", async () => {
  const { host, useCase } = setup();
  const res = await useCase.call(nav("/orders?page=2"));
  assert.equal(res.ok, true);
  assert.deepEqual(host.calls[0]?.action, { kind: "navigate", url: `${BASE}/orders?page=2` });
  if (res.ok) {
    assert.equal(res.page.title, "Orders");
    assert.match(res.page.snapshot, /ref=e1/);
    assert.equal(res.budget.callsLeft, DEFAULT_AGENT_BROWSER_LIMITS.maxCalls - 1);
  }
});

test("a navigation to a denied route, another origin or a non-http address is refused before any browser work and counts as a block", async () => {
  const { host, capability, useCase } = setup();
  for (const url of ["/admin/users", "https://evil.example.org/", "javascript:alert(1)", "file:///etc/passwd"]) {
    const res = await useCase.call(nav(url));
    assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.BLOCKED, url);
  }
  assert.equal(host.calls.length, 0);
  assert.equal(capability.signal.blocks, 4);
  assert.equal(capability.signal.calls, 0, "a refused navigation spends no call");
});

test("a call carrying a malformed argument is refused without reaching the browser", async () => {
  const { host, useCase } = setup();
  const bad: AgentBrowserRequest[] = [
    { sessionId: "s1", agent: "qa-generator", action: "click", ref: "" },
    { sessionId: "s1", agent: "qa-generator", action: "click", ref: "e1; drop" },
    { sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1", text: "x".repeat(5000), submit: false },
    { sessionId: "s1", agent: "qa-generator", action: "navigate", url: "" },
    { sessionId: "s1", agent: "qa-generator", action: "evaluate" } as unknown as AgentBrowserRequest,
  ];
  for (const request of bad) {
    const res = await useCase.call(request);
    assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.INVALID_REQUEST, JSON.stringify(request).slice(0, 60));
  }
  assert.equal(host.calls.length, 0);
});

test("two calls on one account never run at the same time, and a call on another account does not wait", async () => {
  const lock = new AccountLock();
  const host = new FakeHost();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let inFlight = 0;
  let peak = 0;
  host.next = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await gate;
    inFlight -= 1;
    return page();
  };
  const { useCase } = setup({ host, lock });
  const first = useCase.call(nav("/a"));
  const second = useCase.call(nav("/b"));
  await new Promise((r) => setImmediate(r));
  assert.equal(host.calls.length, 1, "the second waits for the account");
  let otherRan = false;
  await lock.withLock("app/other", async () => { otherRan = true; });
  assert.equal(otherRan, true);
  release();
  await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.equal(host.calls.length, 2);
});

test("a call that cannot get the account in time answers that DEV is busy and spends no browser work", async () => {
  const lock = new AccountLock();
  const wait = new AbortController();
  const { host, useCase, capability } = setup({ lock, leaseWait: wait });
  let release!: () => void;
  const held = lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const call = useCase.call(nav("/orders"));
  await new Promise((r) => setImmediate(r));
  wait.abort();
  const res = await call;
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.BUSY);
  assert.equal(host.calls.length, 0);
  assert.equal(capability.signal.calls, 1, "the call was started and counted");
  release();
  await held;
});

test("the lease is released when the browser throws", async () => {
  const host = new FakeHost();
  host.next = () => { throw new Error("browser crashed at /tmp/secret"); };
  const { useCase, lock } = setup({ host });
  const res = await useCase.call(nav("/orders"));
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.FAILED);
  if (!res.ok) assert.doesNotMatch(res.message, /secret/, "a fault's own text is not shown");
  let ran = false;
  await lock.withLock("app/user", async () => { ran = true; });
  assert.equal(ran, true);
});

test("an error the agent can act on is shown to it, redacted", async () => {
  const host = new FakeHost();
  host.next = () => { throw new BrowserActionError("ref e9 is not on the page hunter2"); };
  const { useCase } = setup({ host });
  const res = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "click", ref: "e9" });
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.FAILED);
  if (!res.ok) {
    assert.match(res.message, /ref e9/);
    assert.doesNotMatch(res.message, /hunter2/);
  }
});

test("the calls of a run are capped and the cap holds across refusals of the browser", async () => {
  const { host, useCase } = setup({ limits: { maxCalls: 2 } });
  await useCase.call(nav("/a"));
  await useCase.call(nav("/b"));
  const third = await useCase.call(nav("/c"));
  assert.equal(third.ok === false && third.code, AGENT_BROWSER_REFUSAL.NO_CALLS);
  assert.equal(host.calls.length, 2);
});

test("what the guard stopped during a call is reported to the agent and counted", async () => {
  const host = new FakeHost();
  host.next = () => page({ blocked: [{ reason: "method", detail: "POST https://dev.example.com/api/orders would write to DEV" }] });
  const { useCase, capability } = setup({ host });
  const res = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "click", ref: "e1" });
  assert.equal(res.ok, true);
  if (res.ok) assert.match(res.blocked[0]!.detail, /POST/);
  assert.equal(capability.signal.blocks, 1);
});

test("a session the app dropped is reported as invalidated, the auth port is asked once, and the browser starts over", async () => {
  const host = new FakeHost();
  host.next = () => page({ url: `${BASE}/login`, requestedPath: "/orders" });
  let renewals = 0;
  const { useCase, capability } = setup({ host, renew: async () => { renewals += 1; return true; } });
  const res = await useCase.call(nav("/orders"));
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.SESSION_INVALIDATED);
  if (!res.ok) assert.match(res.message, /session invalidated/);
  assert.equal(renewals, 1);
  assert.equal(host.resets, 1);
  assert.equal(capability.signal.invalidations, 1);
  assert.equal(capability.signal.renewals, 1);
});

test("a session that cannot be renewed says so, and after the allowed renewals no more are attempted", async () => {
  const host = new FakeHost();
  host.next = () => page({ documentStatus: 401 });
  let renewals = 0;
  const { useCase, capability } = setup({ host, renew: async () => { renewals += 1; return false; } });
  const first = await useCase.call(nav("/orders"));
  assert.equal(first.ok === false && first.code, AGENT_BROWSER_REFUSAL.SESSION_INVALIDATED);
  if (!first.ok) assert.match(first.message, /could not be renewed/);
  await useCase.call(nav("/orders"));
  await useCase.call(nav("/orders"));
  assert.ok(renewals <= 2, `renewals stay bounded (saw ${renewals})`);
  assert.equal(capability.signal.invalidations, 3);
  assert.equal(host.resets, 0, "a failed renewal does not discard the browser's state");
});

test("with no auth port a lost session is only reported", async () => {
  const host = new FakeHost();
  host.next = () => page({ url: `${BASE}/login` });
  const { useCase } = setup({ host });
  const res = await useCase.call(nav("/orders"));
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.SESSION_INVALIDATED);
});

test("everything that leaves is redacted and a long tree is cut with a note", async () => {
  const host = new FakeHost();
  host.next = () => page({ title: "Hi hunter2", snapshot: `- text: hunter2\n${"x".repeat(MAX_SNAPSHOT_CHARS * 2)}`, url: `${BASE}/orders?token=abc#f` });
  const { useCase } = setup({ host });
  const res = await useCase.call(nav("/orders"));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.doesNotMatch(JSON.stringify(res), /hunter2/);
    assert.ok(res.page.snapshot.length <= MAX_SNAPSHOT_CHARS + 200);
    assert.equal(res.page.truncated, true);
    assert.doesNotMatch(res.page.url, /token|#f/, "the address carries no query or fragment");
  }
});
