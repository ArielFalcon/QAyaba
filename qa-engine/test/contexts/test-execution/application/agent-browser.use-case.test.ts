import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { AgentBrowserCapability, AGENT_BROWSER_REFUSAL } from "@contexts/test-execution/domain/agent-browser-capability.ts";
import { createRouteGuard } from "@contexts/test-execution/domain/agent-browser-route-guard.ts";
import { AgentBrowserUseCase, LOW_CALLS, MAX_REPORTED_BLOCKS, MAX_SNAPSHOT_CHARS, MAX_TYPED_CHARS, MAX_URL_CHARS, type AgentBrowserRequest } from "@contexts/test-execution/application/agent-browser.use-case.ts";
import { BrowserActionError, type BrowserAction, type PageState } from "@contexts/test-execution/domain/agent-browser-host.ts";
import { type AgentBrowserHostPort } from "@contexts/test-execution/application/ports/agent-browser-host.port.ts";
import { DEFAULT_AGENT_BROWSER_LIMITS } from "@kernel/agent-browser.ts";

const BASE = "https://dev.example.com";

function page(over: Partial<PageState> = {}): PageState {
  return { url: `${BASE}/orders`, title: "Orders", snapshot: "- heading \"Orders\" [ref=e1]", passwordFieldVisible: false, requestedPath: "/orders", blocked: [], notes: [], ...over };
}

class FakeHost implements AgentBrowserHostPort {
  readonly calls: { sessionId: string; action: BrowserAction }[] = [];
  readonly timeouts: number[] = [];
  readonly readOnly: (boolean | undefined)[] = [];
  resets = 0;
  closed = 0;
  next: () => Promise<PageState> | PageState = () => page();
  async perform(sessionId: string, action: BrowserAction, opts?: { timeoutMs: number; readOnly?: boolean }): Promise<PageState> {
    this.calls.push({ sessionId, action });
    this.readOnly.push(opts?.readOnly);
    if (opts) this.timeouts.push(opts.timeoutMs);
    return this.next();
  }
  async reset(): Promise<void> { this.resets += 1; }
  async close(): Promise<void> { this.closed += 1; }
}

function setup(over: { host?: FakeHost; lock?: AccountLock; renew?: (() => Promise<boolean>) | undefined; limits?: Partial<typeof DEFAULT_AGENT_BROWSER_LIMITS>; leaseWait?: AbortController; denyRoutes?: string[]; now?: () => number; expiresAtMs?: number; runSignal?: AbortSignal; loginPath?: string; deadline?: { remainingMs: () => number | undefined } } = {}) {
  const host = over.host ?? new FakeHost();
  const capability = new AgentBrowserCapability({ runId: "r1", limits: { ...DEFAULT_AGENT_BROWSER_LIMITS, ...over.limits }, expiresAtMs: over.expiresAtMs ?? 1_000_000, now: over.now ?? (() => 0) });
  capability.bindSession("s1");
  capability.bindSession("explore", "r1-explore-0", "qa-explore");
  capability.setShare("r1-explore-0", 5);
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
    ...(over.deadline ? { deadline: { ...over.deadline, describe: () => undefined } } : {}),
    leaseWaitSignal: () => over.leaseWait?.signal ?? new AbortController().signal,
    ...(over.runSignal ? { signal: over.runSignal } : {}),
    ...(over.loginPath !== undefined ? { loginPath: over.loginPath } : {}),
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

test("an explore session's call reaches the host read-only and an authoring session's does not", async () => {
  const { host, useCase } = setup();
  await useCase.call({ ...nav("/orders"), sessionId: "explore", agent: "qa-explore" });
  await useCase.call(nav("/orders"));
  assert.deepEqual(host.readOnly, [true, undefined]);
});

test("the pages a flow's sessions were shown are the capability's ledger of reads, by path, and a refused call leaves none", async () => {
  const { host, capability, useCase } = setup();
  host.next = () => page({ url: `${BASE}/orders?page=2#top`, requestedPath: "/orders" });
  await useCase.call({ ...nav("/orders"), sessionId: "explore", agent: "qa-explore" });
  await useCase.call({ ...nav("/admin/users"), sessionId: "explore", agent: "qa-explore" });
  await useCase.call(nav("/orders"));
  assert.deepEqual(capability.readsOf("r1-explore-0"), ["/orders"], "the path alone, once; a session bound to no flow leaves none and a blocked route is not read");
  assert.deepEqual(capability.readsOf("r1-explore-1"), []);
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
  assert.equal(capability.signal.calls, 0, "a call that never began is not spent");
  release();
  await held;
});

test("a call that gave up waiting for the account does not use a call of its flow's share either", async () => {
  const lock = new AccountLock();
  const { useCase, capability } = setup({ lock });
  capability.bindSession("flow-session", "flow-a");
  capability.setShare("flow-a", 1);
  const flowCall = { ...nav("/orders"), sessionId: "flow-session", agent: "qa-sidekick" };
  let release!: () => void;
  const held = lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const ended = new AbortController();
  const waiting = useCase.call(flowCall, ended.signal);
  await new Promise((r) => setImmediate(r));
  ended.abort();
  await waiting;
  release();
  await held;
  const again = await useCase.call(flowCall);
  assert.equal(again.ok, true, "the flow's one call is still there");
});

test("a call whose session ends while it waits for the account is not spent", async () => {
  const lock = new AccountLock();
  const { useCase, capability } = setup({ lock });
  let release!: () => void;
  const held = lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const ended = new AbortController();
  const waiting = useCase.call(nav("/orders"), ended.signal);
  await new Promise((r) => setImmediate(r));
  ended.abort();
  await waiting;
  assert.equal(capability.signal.calls, 0);
  release();
  await held;
});

test("a call that waited for the account is bounded by the time the run has left when it gets it", async () => {
  let left: number | undefined = 600_000;
  const lock = new AccountLock();
  const { host, useCase } = setup({ lock, deadline: { remainingMs: () => left } });
  let release!: () => void;
  const held = lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const waiting = useCase.call(nav("/orders"));
  await new Promise((r) => setImmediate(r));
  left = 3_000;
  release();
  await held;
  assert.equal((await waiting).ok, true);
  assert.equal(host.timeouts[0], 3_000);
});

test("a call that waited for the account while the capability ran out of time is refused without touching the browser", async () => {
  let clock = 0;
  const lock = new AccountLock();
  const { host, useCase, capability } = setup({ lock, now: () => clock, expiresAtMs: 100 });
  let release!: () => void;
  const held = lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const waiting = useCase.call(nav("/orders"));
  await new Promise((r) => setImmediate(r));
  clock = 100;
  release();
  await held;
  const res = await waiting;
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.EXPIRED);
  assert.equal(host.calls.length, 0);
  assert.equal(capability.signal.calls, 0);
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

test("pages that merely look like a login, or ask for a password after a click, do not cost the run a renewal and its siblings their pages", async () => {
  const host = new FakeHost();
  let renewals = 0;
  const { useCase, capability } = setup({ host, renew: async () => { renewals += 1; return true; } });
  host.next = () => page({ url: `${BASE}/auth/callback`, requestedPath: "/auth/callback" });
  assert.equal((await useCase.call(nav("/auth/callback"))).ok, true, "a page the agent asked for");
  host.next = () => page({ url: `${BASE}/settings/security`, requestedPath: "/settings", passwordFieldVisible: true });
  assert.equal((await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "click", ref: "e3" })).ok, true, "a page a click led to");
  assert.equal(renewals, 0);
  assert.equal(host.resets, 0);
  assert.equal(capability.signal.invalidations, 0);
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

test("a snapshot asks the browser for the page as it is, with no argument", async () => {
  const { host, useCase } = setup();
  const res = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "snapshot" });
  assert.equal(res.ok, true);
  assert.deepEqual(host.calls[0]?.action, { kind: "snapshot" });
});

test("a refs of any length the snapshot gives is accepted, and one that is not an identifier is not", async () => {
  const { host, useCase } = setup();
  for (const ref of ["e5", "e123", "f1e12", "E7", `e${"1".repeat(15)}`]) {
    const res = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "click", ref });
    assert.equal(res.ok, true, ref);
  }
  assert.equal(host.calls.length, 5);
  for (const ref of [`e${"1".repeat(16)}`, "1e", "e-1", "e 1"]) {
    const res = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "click", ref });
    assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.INVALID_REQUEST, ref);
  }
});

test("typing forwards its text, and submit only when it is true; a submit that is not a boolean is refused", async () => {
  const { host, useCase } = setup();
  await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1", text: "hi" });
  await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1", text: "hi", submit: false });
  await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1", text: "hi", submit: true });
  assert.deepEqual(host.calls.map((c) => c.action), [
    { kind: "type", ref: "e1", text: "hi", submit: false },
    { kind: "type", ref: "e1", text: "hi", submit: false },
    { kind: "type", ref: "e1", text: "hi", submit: true },
  ]);
  const bad = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1", text: "hi", submit: "yes" } as unknown as AgentBrowserRequest);
  assert.equal(bad.ok === false && bad.code, AGENT_BROWSER_REFUSAL.INVALID_REQUEST);
  const missingText = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1" } as unknown as AgentBrowserRequest);
  assert.equal(missingText.ok === false && missingText.code, AGENT_BROWSER_REFUSAL.INVALID_REQUEST);
});

test("the text and the address are held to their lengths, exactly", async () => {
  const { host, useCase } = setup();
  const atText = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1", text: "x".repeat(MAX_TYPED_CHARS) });
  assert.equal(atText.ok, true);
  const overText = await useCase.call({ sessionId: "s1", agent: "qa-generator", action: "type", ref: "e1", text: "x".repeat(MAX_TYPED_CHARS + 1) });
  assert.equal(overText.ok === false && overText.code, AGENT_BROWSER_REFUSAL.INVALID_REQUEST);
  const atUrl = await useCase.call(nav(`/${"a".repeat(MAX_URL_CHARS - 1)}`));
  assert.equal(atUrl.ok, true);
  const overUrl = await useCase.call(nav(`/${"a".repeat(MAX_URL_CHARS)}`));
  assert.equal(overUrl.ok === false && overUrl.code, AGENT_BROWSER_REFUSAL.INVALID_REQUEST);
  assert.equal(host.calls.length, 2);
});

test("an address is trimmed before it is resolved, a blank one is refused, and one that is not an address is refused", async () => {
  const { host, useCase } = setup();
  assert.equal((await useCase.call(nav("  /orders  "))).ok, true);
  assert.deepEqual(host.calls[0]?.action, { kind: "navigate", url: `${BASE}/orders` });
  assert.equal((await useCase.call(nav("   "))).ok === false, true);
  const garbage = await useCase.call(nav("http://["));
  assert.equal(garbage.ok === false && garbage.code, AGENT_BROWSER_REFUSAL.INVALID_REQUEST);
  assert.equal(host.calls.length, 1);
});

test("the page's address is reported whole except for its query and fragment, and an address that is not a URL is cut at them", async () => {
  const host = new FakeHost();
  host.next = () => page({ url: `${BASE}/orders/42?token=abc#frag` });
  const first = await setup({ host }).useCase.call(nav("/orders/42"));
  assert.equal(first.ok && first.page.url, `${BASE}/orders/42`);
  const odd = new FakeHost();
  odd.next = () => page({ url: "not a url?token=abc#frag", requestedPath: "not a url" });
  const second = await setup({ host: odd }).useCase.call(nav("/orders"));
  assert.equal(second.ok && second.page.url, "not a url");
});

test("a tree exactly at the limit is whole, and one character over is cut and said so", async () => {
  const exact = new FakeHost();
  exact.next = () => page({ snapshot: "x".repeat(MAX_SNAPSHOT_CHARS) });
  const whole = await setup({ host: exact }).useCase.call(nav("/orders"));
  assert.equal(whole.ok && whole.page.truncated, undefined);
  assert.equal(whole.ok && whole.page.snapshot.length, MAX_SNAPSHOT_CHARS);
  assert.equal(whole.ok && whole.notes.length, 0);
  const over = new FakeHost();
  over.next = () => page({ snapshot: "x".repeat(MAX_SNAPSHOT_CHARS + 1) });
  const cut = await setup({ host: over }).useCase.call(nav("/orders"));
  assert.equal(cut.ok && cut.page.truncated, true);
  assert.equal(cut.ok && cut.page.snapshot.length, MAX_SNAPSHOT_CHARS);
  assert.equal(cut.ok && cut.notes.length, 1);
});

test("the agent is told when the run's calls are about to run out, and not before", async () => {
  const { useCase } = setup({ limits: { maxCalls: LOW_CALLS + 2 } });
  const first = await useCase.call(nav("/a"));
  assert.equal(first.ok && first.notes.length, 0, `${LOW_CALLS + 1} left`);
  const second = await useCase.call(nav("/b"));
  assert.equal(second.ok && second.notes.length, 1, `${LOW_CALLS} left`);
  assert.equal(second.ok && second.budget.callsLeft, LOW_CALLS);
});

test("no more than the allowed number of blocks are listed, though all are counted", async () => {
  const host = new FakeHost();
  host.next = () => page({ blocked: Array.from({ length: MAX_REPORTED_BLOCKS + 3 }, (_, i) => ({ reason: "method" as const, detail: `POST /api/${i}` })) });
  const { useCase, capability } = setup({ host });
  const res = await useCase.call(nav("/orders"));
  assert.equal(res.ok && res.blocked.length, MAX_REPORTED_BLOCKS);
  assert.equal(capability.signal.blocks, MAX_REPORTED_BLOCKS + 3);
});

test("the app's own login path ends a session too, and the page's status is read", async () => {
  const host = new FakeHost();
  host.next = () => page({ url: `${BASE}/entrar` });
  const withHint = await setup({ host, loginPath: "/entrar" }).useCase.call(nav("/orders"));
  assert.equal(withHint.ok === false && withHint.code, AGENT_BROWSER_REFUSAL.SESSION_INVALIDATED);
  const without = await setup({ host }).useCase.call(nav("/orders"));
  assert.equal(without.ok, true, "without the hint the same page is just a page");
  const unauthorized = new FakeHost();
  unauthorized.next = () => page({ documentStatus: 401 });
  assert.equal((await setup({ host: unauthorized }).useCase.call(nav("/orders"))).ok, false);
  const password = new FakeHost();
  password.next = () => page({ url: `${BASE}/welcome`, passwordFieldVisible: true });
  assert.equal((await setup({ host: password }).useCase.call(nav("/orders"))).ok, false);
  const sameKeep = new FakeHost();
  sameKeep.next = () => page({ url: `${BASE}/orders`, passwordFieldVisible: true, requestedPath: "/orders" });
  assert.equal((await setup({ host: sameKeep }).useCase.call(nav("/orders"))).ok, true);
});

test("a sign-in that throws counts as one that failed", async () => {
  const host = new FakeHost();
  host.next = () => page({ url: `${BASE}/login` });
  const { useCase, capability } = setup({ host, renew: async () => { throw new Error("login script crashed"); } });
  const res = await useCase.call(nav("/orders"));
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.SESSION_INVALIDATED);
  if (!res.ok) assert.match(res.message, /could not be renewed/);
  assert.equal(host.resets, 0);
  assert.deepEqual(capability.signal, { calls: 1, blocks: 0, invalidations: 1, renewals: 0 });
  assert.equal(capability.canRenew(), true, "one failed attempt of two");
});

test("a call whose session ended while it waited for the account is a cancelled call, not a busy account, and the run's own end cancels it too", async () => {
  const lock = new AccountLock();
  let release!: () => void;
  const held = lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const callAbort = new AbortController();
  const { useCase } = setup({ lock });
  const pending = useCase.call(nav("/orders"), callAbort.signal);
  await new Promise((r) => setImmediate(r));
  callAbort.abort();
  const res = await pending;
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.FAILED);
  if (!res.ok) assert.match(res.message, /cancel/);

  const runAbort = new AbortController();
  const second = setup({ lock, runSignal: runAbort.signal }).useCase.call(nav("/orders"));
  await new Promise((r) => setImmediate(r));
  runAbort.abort();
  const ended = await second;
  assert.equal(ended.ok === false && ended.code, AGENT_BROWSER_REFUSAL.FAILED);
  release();
  await held;
});

test("a title is cut at 300 characters and not before", async () => {
  const exact = new FakeHost();
  exact.next = () => page({ title: "t".repeat(300) });
  const whole = await setup({ host: exact }).useCase.call(nav("/orders"));
  assert.equal(whole.ok && whole.page.title.length, 300);
  const over = new FakeHost();
  over.next = () => page({ title: "t".repeat(301) });
  const cut = await setup({ host: over }).useCase.call(nav("/orders"));
  assert.equal(cut.ok && cut.page.title.length, 300);
});

test("what the browser says besides the tree reaches the agent, redacted", async () => {
  const host = new FakeHost();
  host.next = () => page({ notes: ["a dialog was dismissed hunter2"] });
  const res = await setup({ host }).useCase.call(nav("/orders"));
  assert.equal(res.ok && res.notes.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /hunter2/);
});

test("the end of the run stops a call even when the call has a signal of its own", async () => {
  const lock = new AccountLock();
  let release!: () => void;
  const held = lock.withLock("app/user", () => new Promise<void>((r) => { release = r; }));
  const runAbort = new AbortController();
  const { useCase } = setup({ lock, runSignal: runAbort.signal });
  const pending = useCase.call(nav("/orders"), new AbortController().signal);
  await new Promise((r) => setImmediate(r));
  runAbort.abort();
  const res = await pending;
  assert.equal(res.ok === false && res.code, AGENT_BROWSER_REFUSAL.FAILED);
  release();
  await held;
});

test("sign-ins that keep throwing stop being attempted once the allowed number is used", async () => {
  const host = new FakeHost();
  host.next = () => page({ url: `${BASE}/login` });
  let attempts = 0;
  const { useCase } = setup({ host, renew: async () => { attempts += 1; throw new Error("login script crashed"); } });
  for (let i = 0; i < 4; i++) await useCase.call(nav("/orders"));
  assert.equal(attempts, 2);
});
