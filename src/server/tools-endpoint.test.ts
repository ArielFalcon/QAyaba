import { test } from "node:test";
import assert from "node:assert/strict";
import { ClosedLoopRegistry } from "@contexts/qa-run-orchestration/infrastructure/closed-loop-registry";
import { RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability";
import type { RunSpecRequest, RunSpecResponse } from "@contexts/test-execution/application/run-spec.use-case";
import { AgentBrowserRegistry } from "@contexts/qa-run-orchestration/infrastructure/agent-browser-registry";
import { AgentBrowserCapability, type AgentBrowserRefusalCode } from "@contexts/test-execution/domain/agent-browser-capability";
import type { AgentBrowserRequest, AgentBrowserResponse } from "@contexts/test-execution/application/agent-browser.use-case";
import net from "node:net";
import { AUTHBROWSER_PATH, DEFAULT_TOOLS_PORT, MIN_TOOLS_TOKEN_CHARS, createToolsServer, createToolsRateLimiter, handleToolsRequest, resolveToolsListenHost, resolveToolsPort, resolveToolsToken, type ToolsRequest } from "./tools-endpoint";

const TOKEN = "service-token-for-tests-0123456789abcdef";

function liveRegistry(call: (request: RunSpecRequest) => Promise<RunSpecResponse> = async () => ({ ok: true, report: { status: "passed", tests: [], passedTests: 0, budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 1 } } })) {
  const registry = new ClosedLoopRegistry();
  const capability = new RunSpecCapability({ runId: "run-1", limits: { maxCalls: 2, perCallMs: 60_000, maxDevWrites: 5 }, expiresAtMs: Number.MAX_SAFE_INTEGER, now: () => 0 });
  registry.register({ runId: "run-1", capability, call });
  registry.bindSession({ sessionId: "ses-1", runId: "run-1", agent: "qa-generator" });
  return registry;
}

const request = (over: Partial<ToolsRequest> = {}): ToolsRequest => ({
  method: "POST",
  path: "/internal/run-spec",
  authorization: `Bearer ${TOKEN}`,
  body: JSON.stringify({ sessionID: "ses-1", agent: "qa-generator", path: "flows/a.spec.ts" }),
  ...over,
});

const handle = (req: ToolsRequest, registry = liveRegistry()) => handleToolsRequest(req, { token: TOKEN, registry });

test("a call without the service token, or with another, is refused before anything is read", async () => {
  for (const authorization of [undefined, "", "Bearer", "Bearer wrong", `Basic ${TOKEN}`, `bearer ${TOKEN}`, `Bearer ${TOKEN} `]) {
    const response = await handle(request({ authorization }));
    assert.equal(response.status, 401, String(authorization));
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(TOKEN));
  }
});

test("only POST /internal/run-spec exists", async () => {
  assert.equal((await handle(request({ path: "/api/health" }))).status, 404);
  assert.equal((await handle(request({ method: "GET" }))).status, 405);
});

test("a body that is not a bounded JSON call is a bad request", async () => {
  for (const body of ["", "not json", "[]", "null", JSON.stringify({ sessionID: "s" }), JSON.stringify({ sessionID: 1, agent: "a", path: "p" }), JSON.stringify({ sessionID: "s", agent: "a", path: "p".repeat(600) }), "x".repeat(20_000)]) {
    assert.equal((await handle(request({ body }))).status, 400, body.slice(0, 30));
  }
});

test("a session no loop owns is forbidden, and so is any other agent's", async () => {
  const stranger = await handle(request({ body: JSON.stringify({ sessionID: "ses-other", agent: "qa-generator", path: "a.spec.ts" }) }));
  assert.equal(stranger.status, 403);
  assert.equal((stranger.body as { code: string }).code, "unknown-session");

  const registry = liveRegistry(async (call) => (call.agent === "qa-generator" ? { ok: true, report: { status: "passed", tests: [], passedTests: 0, budget: { callsLeft: 0, msLeft: undefined, devWritesLeft: 0 } } } : { ok: false, code: "wrong-agent", message: "run_spec is available to the generator only", budget: { callsLeft: 0, msLeft: undefined, devWritesLeft: 0 } }));
  const reviewer = await handle(request({ body: JSON.stringify({ sessionID: "ses-1", agent: "qa-reviewer", path: "a.spec.ts" }) }), registry);
  assert.equal(reviewer.status, 403);
});

test("a call from the generator's session runs and returns the report", async () => {
  const seen: RunSpecRequest[] = [];
  const registry = liveRegistry(async (call) => (seen.push(call), { ok: true, report: { status: "failed", tests: [{ title: "t", status: "failed" }], passedTests: 0, budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 2 } } }));
  const response = await handle(request({ body: JSON.stringify({ sessionID: "ses-1", agent: "qa-generator", path: "flows/a.spec.ts", grep: "adds" }) }), registry);
  assert.equal(response.status, 200);
  assert.equal((response.body as { ok: boolean }).ok, true);
  assert.deepEqual(seen, [{ sessionId: "ses-1", agent: "qa-generator", path: "flows/a.spec.ts", grep: "adds" }]);
});

test("a call from the sidekick's session of a flow reaches that flow's loop alone, and the generator's loop is not reachable from it", async () => {
  const registry = new ClosedLoopRegistry();
  const reached: string[] = [];
  const loop = (delegationId: string | undefined): void => {
    const capability = new RunSpecCapability({ runId: "run-1", limits: { maxCalls: 2, perCallMs: 60_000, maxDevWrites: 5 }, expiresAtMs: Number.MAX_SAFE_INTEGER, now: () => 0, ...(delegationId ? { agents: new Set(["qa-sidekick"]) } : {}) });
    registry.register({ runId: "run-1", ...(delegationId ? { delegationId } : {}), capability, call: async () => (reached.push(delegationId ?? "run"), { ok: true, report: { status: "passed", tests: [], passedTests: 1, budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 1 } } }) });
  };
  loop(undefined);
  loop("run-1-cart");
  registry.bindSession({ sessionId: "gen", runId: "run-1", agent: "qa-generator" });
  registry.bindSession({ sessionId: "side", runId: "run-1", agent: "qa-sidekick", delegationId: "run-1-cart" });
  const body = (sessionID: string, agent: string) => JSON.stringify({ sessionID, agent, path: "flows/cart.spec.ts" });
  assert.equal((await handle(request({ body: body("side", "qa-sidekick") }), registry)).status, 200);
  assert.equal((await handle(request({ body: body("gen", "qa-generator") }), registry)).status, 200);
  assert.deepEqual(reached, ["run-1-cart", "run"]);
});

test("each refusal has its own status", async () => {
  const cases: Array<[string, number]> = [["invalid-request", 400], ["not-found", 404], ["revoked", 403], ["expired", 403], ["no-calls", 429], ["no-writes", 429], ["no-time", 429], ["busy", 409]];
  for (const [code, status] of cases) {
    const registry = liveRegistry(async () => ({ ok: false, code: code as never, message: `refused: ${code}`, budget: { callsLeft: 0, msLeft: undefined, devWritesLeft: 0 } }));
    const response = await handle(request(), registry);
    assert.equal(response.status, status, code);
    assert.equal((response.body as { message: string }).message, `refused: ${code}`);
  }
});

test("a fault inside the call is a 500 that says nothing about its cause", async () => {
  const registry = liveRegistry(async () => { throw new Error("secret path /app/data/x leaked"); });
  const response = await handle(request(), registry);
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(response.body), /secret path/);
});

test("the token is the configured one, or a random one for this boot that no caller can know", () => {
  const quiet: string[] = [];
  const long = "t".repeat(MIN_TOOLS_TOKEN_CHARS);
  assert.deepEqual(resolveToolsToken({ QA_TOOLS_TOKEN: ` ${long} ` }, { warn: (m) => void quiet.push(m) }), { token: long, generated: false });
  assert.equal(quiet.length, 0);
  const warnings: string[] = [];
  const first = resolveToolsToken({}, { warn: (m) => void warnings.push(m) });
  assert.equal(first.generated, true);
  assert.ok(first.token.length >= 32);
  assert.match(warnings[0]!, /QA_TOOLS_TOKEN/);
  assert.notEqual(resolveToolsToken({ QA_TOOLS_TOKEN: "  " }, { warn: () => {} }).token, first.token);
});

test("the port is QA_TOOLS_PORT, defaulting to a port the compose file does not publish", () => {
  assert.equal(resolveToolsPort({}), DEFAULT_TOOLS_PORT);
  assert.equal(resolveToolsPort({ QA_TOOLS_PORT: "4590" }), 4590);
  assert.throws(() => resolveToolsPort({ QA_TOOLS_PORT: "abc" }), /QA_TOOLS_PORT/);
  assert.throws(() => resolveToolsPort({ QA_TOOLS_PORT: "70000" }), /QA_TOOLS_PORT/);
});

const PAGE_OK: AgentBrowserResponse = { ok: true, page: { url: "https://dev/x", title: "t", snapshot: "- heading" }, blocked: [], notes: [], budget: { callsLeft: 3 } };

function liveBrowsers(call: (request: AgentBrowserRequest) => Promise<AgentBrowserResponse> = async () => PAGE_OK) {
  const browsers = new AgentBrowserRegistry();
  browsers.register({
    runId: "run-1",
    capability: new AgentBrowserCapability({ runId: "run-1", expiresAtMs: Number.MAX_SAFE_INTEGER, now: () => 0 }),
    call,
    endSession: () => undefined,
    close: async () => undefined,
  });
  browsers.bindSession({ sessionId: "ses-1", runId: "run-1", agent: "qa-generator" });
  return browsers;
}

const browserRequest = (body: unknown, over: Partial<ToolsRequest> = {}): ToolsRequest => ({
  method: "POST",
  path: AUTHBROWSER_PATH,
  authorization: `Bearer ${TOKEN}`,
  body: JSON.stringify(body),
  ...over,
});

const handleBrowser = (req: ToolsRequest, browsers: AgentBrowserRegistry | null = liveBrowsers()) =>
  handleToolsRequest(req, { token: TOKEN, registry: new ClosedLoopRegistry(), ...(browsers ? { browsers } : {}) });

test("the browser endpoint wants the service token like run_spec's", async () => {
  for (const authorization of [undefined, "Bearer wrong"]) {
    const response = await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "snapshot" }, { authorization }));
    assert.equal(response.status, 401);
  }
});

test("without a browser registry the endpoint answers that the tool is not available, and run_spec still works", async () => {
  const none = await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "snapshot" }), null);
  assert.equal(none.status, 403);
  assert.equal((none.body as { code: string }).code, "unknown-session");
  assert.equal((await handle(request())).status, 200);
});

test("a navigation from an authoring session reaches the run's browser with the caller's words and nothing else", async () => {
  const seen: AgentBrowserRequest[] = [];
  const response = await handleBrowser(
    browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "navigate", url: "/orders", extra: "ignored", ref: "e1" }),
    liveBrowsers(async (call) => (seen.push(call), PAGE_OK)),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [{ sessionId: "ses-1", agent: "qa-generator", action: "navigate", url: "/orders" }]);
});

test("click and type carry their ref, text and submit", async () => {
  const seen: AgentBrowserRequest[] = [];
  const browsers = liveBrowsers(async (call) => (seen.push(call), PAGE_OK));
  await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "click", ref: "e7" }), browsers);
  await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "type", ref: "e2", text: "hello", submit: true }), browsers);
  assert.deepEqual(seen, [
    { sessionId: "ses-1", agent: "qa-generator", action: "click", ref: "e7" },
    { sessionId: "ses-1", agent: "qa-generator", action: "type", ref: "e2", text: "hello", submit: true },
  ]);
});

test("a body that is not a bounded browser call is a bad request, and an action outside the four never reaches the browser", async () => {
  const seen: AgentBrowserRequest[] = [];
  const browsers = liveBrowsers(async (call) => (seen.push(call), PAGE_OK));
  for (const body of [
    { sessionID: "ses-1", agent: "qa-generator" },
    { sessionID: "ses-1", agent: "qa-generator", action: "evaluate", expression: "1" },
    { sessionID: "ses-1", agent: "qa-generator", action: "navigate", url: 4 },
    { sessionID: 1, agent: "qa-generator", action: "snapshot" },
    { sessionID: "ses-1", agent: "qa-generator", action: "type", ref: "e1", text: "x".repeat(20_000) },
  ]) {
    assert.equal((await handleBrowser(browserRequest(body), browsers)).status, 400, JSON.stringify(body).slice(0, 50));
  }
  assert.equal(seen.length, 0);
});

test("a session no browser owns is forbidden", async () => {
  const response = await handleBrowser(browserRequest({ sessionID: "ses-other", agent: "qa-generator", action: "snapshot" }));
  assert.equal(response.status, 403);
});

test("each browser refusal has its own status and carries the message", async () => {
  const cases: Array<[AgentBrowserRefusalCode, number]> = [["invalid-request", 400], ["revoked", 403], ["expired", 403], ["unknown-session", 403], ["wrong-agent", 403], ["blocked", 403], ["no-calls", 429], ["busy", 409], ["session-invalidated", 409], ["failed", 422]];
  for (const [code, status] of cases) {
    const browsers = liveBrowsers(async () => ({ ok: false, code, message: `refused: ${code}`, budget: { callsLeft: 0 } }));
    const response = await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "snapshot" }), browsers);
    assert.equal(response.status, status, code);
    assert.equal((response.body as { message: string }).message, `refused: ${code}`);
  }
});

test("a fault inside a browser call is a 500 that says nothing about its cause", async () => {
  const response = await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "snapshot" }), liveBrowsers(async () => { throw new Error("secret path /app/data/x leaked"); }));
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(response.body), /secret path/);
});


test("a configured token shorter than the minimum is not used: a random one stands in, no tool is granted, and the log says why", () => {
  const warnings: string[] = [];
  const short = resolveToolsToken({ QA_TOOLS_TOKEN: "t".repeat(MIN_TOOLS_TOKEN_CHARS - 1) }, { warn: (m) => void warnings.push(m) });
  assert.equal(short.generated, true);
  assert.ok(short.token.length >= MIN_TOOLS_TOKEN_CHARS);
  assert.notEqual(short.token, "t".repeat(MIN_TOOLS_TOKEN_CHARS - 1));
  assert.match(warnings.join("\n"), new RegExp(`at least ${MIN_TOOLS_TOKEN_CHARS}`));
  assert.doesNotMatch(warnings.join("\n"), /ttttt/, "the log never quotes the token");
});

test("an endpoint built with a short token answers nothing: it fails closed instead of trusting a guessable secret", async () => {
  const response = await handleToolsRequest(request({ authorization: "Bearer short" }), { token: "short", registry: liveRegistry() });
  assert.equal(response.status, 503);
  const sameToken = await handleToolsRequest(request(), { token: "short", registry: liveRegistry() });
  assert.equal(sameToken.status, 503);
});

test("a session that calls too often is told to slow down, and other sessions are not affected", async () => {
  let clock = 0;
  const limiter = createToolsRateLimiter({ maxCallsPerWindow: 3, windowMs: 1000, now: () => clock });
  const deps = { token: TOKEN, registry: liveRegistry(), limiter };
  const call = (sessionID: string) => handleToolsRequest(request({ body: JSON.stringify({ sessionID, agent: "qa-generator", path: "flows/a.spec.ts" }) }), deps);
  assert.deepEqual([await call("ses-1"), await call("ses-1"), await call("ses-1")].map((r) => r.status), [200, 200, 200]);
  const limited = await call("ses-1");
  assert.equal(limited.status, 429);
  assert.equal((limited.body as { code: string }).code, "rate-limited");
  assert.equal((await call("ses-other")).status, 403, "another session reaches the normal answer");
  clock = 1001;
  assert.equal((await call("ses-1")).status, 200, "the window has passed");
});

test("repeated calls with a wrong token from one address are slowed down too, and a right token from another address still works", async () => {
  const limiter = createToolsRateLimiter({ maxCallsPerWindow: 100, maxFailuresPerWindow: 2, windowMs: 1000, now: () => 0 });
  const deps = { token: TOKEN, registry: liveRegistry(), limiter };
  const bad = (remote: string) => handleToolsRequest(request({ authorization: "Bearer wrong", remote }), deps);
  assert.deepEqual([await bad("10.0.0.9"), await bad("10.0.0.9"), await bad("10.0.0.9")].map((r) => r.status), [401, 401, 429]);
  assert.equal((await handleToolsRequest(request({ remote: "10.0.0.7" }), deps)).status, 200);
});

test("a request that stalls while its body is sent is cut off, and a body over the cap is refused", async () => {
  const server = createToolsServer({ token: TOKEN, registry: liveRegistry(), bodyTimeoutMs: 150 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const stalled = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`POST /internal/run-spec HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 50\r\n\r\n{"sess`));
      let data = "";
      socket.on("data", (d) => { data += d.toString(); });
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 3000);
    });
    assert.match(stalled, /^HTTP\/1\.1 (400|408)/, "answered or closed, never left waiting");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("the listener is bounded on headers and on the whole request, so a client cannot hold it open", () => {
  const server = createToolsServer({ token: TOKEN, registry: liveRegistry() });
  assert.ok(server.headersTimeout > 0 && server.headersTimeout <= 15_000);
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 30_000);
  assert.ok(server.maxHeadersCount !== null && server.maxHeadersCount <= 50);
  server.close();
});

test("the tools listener binds to the container's one network interface when LISTEN_HOST is a wildcard, and to an explicit QA_TOOLS_LISTEN_HOST always", () => {
  const eth0 = { lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }], eth0: [{ address: "172.18.0.3", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }] };
  const two = { ...eth0, eth1: [{ address: "172.19.0.4", family: "IPv4", internal: false }] };
  assert.equal(resolveToolsListenHost({}, "0.0.0.0", eth0), "172.18.0.3");
  assert.equal(resolveToolsListenHost({}, "0.0.0.0", two), "0.0.0.0", "with several interfaces there is no single one to choose: the wildcard stays, and the doc says to set QA_TOOLS_LISTEN_HOST");
  assert.equal(resolveToolsListenHost({}, "127.0.0.1", eth0), "127.0.0.1", "a loopback listener stays on loopback");
  assert.equal(resolveToolsListenHost({ QA_TOOLS_LISTEN_HOST: "172.19.0.4" }, "0.0.0.0", two), "172.19.0.4");
  assert.equal(resolveToolsListenHost({}, "0.0.0.0", {}), "0.0.0.0");
});

/* --- the message id: a join key for the trace, never an input to a decision --- */

test("a run_spec call carries the message id the tool reported, and a call without one is served as before", async () => {
  const seen: RunSpecRequest[] = [];
  const registry = liveRegistry(async (call) => (seen.push(call), { ok: true, report: { status: "passed", tests: [], passedTests: 0, budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 1 } } }));
  await handle(request({ body: JSON.stringify({ sessionID: "ses-1", agent: "qa-generator", path: "flows/a.spec.ts", messageID: "msg_0e8f672fd0016ECRQbc2r1kiBB" }) }), registry);
  await handle(request(), registry);
  assert.equal(seen[0]!.messageId, "msg_0e8f672fd0016ECRQbc2r1kiBB");
  assert.equal(seen[1]!.messageId, undefined);
});

test("a browser call carries the message id the tool reported", async () => {
  const seen: AgentBrowserRequest[] = [];
  await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "snapshot", messageID: "msg_abc123" }), liveBrowsers(async (call) => (seen.push(call), PAGE_OK)));
  assert.equal(seen[0]!.messageId, "msg_abc123");
});

test("a message id that is not a short plain identifier is dropped and the call is served without it", async () => {
  const seenSpec: RunSpecRequest[] = [];
  const seenBrowser: AgentBrowserRequest[] = [];
  const registry = liveRegistry(async (call) => (seenSpec.push(call), { ok: true, report: { status: "passed", tests: [], passedTests: 0, budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 1 } } }));
  const browsers = liveBrowsers(async (call) => (seenBrowser.push(call), PAGE_OK));
  for (const messageID of [7, "", "x".repeat(201), "msg 1", "msg\n1", "msg/../1", { id: "m" }, ["m"]]) {
    const spec = await handle(request({ body: JSON.stringify({ sessionID: "ses-1", agent: "qa-generator", path: "flows/a.spec.ts", messageID }) }), registry);
    const browser = await handleBrowser(browserRequest({ sessionID: "ses-1", agent: "qa-generator", action: "snapshot", messageID }), browsers);
    assert.equal(spec.status, 200, JSON.stringify(messageID));
    assert.equal(browser.status, 200, JSON.stringify(messageID));
  }
  assert.ok(seenSpec.length > 0 && seenBrowser.length > 0);
  assert.ok(seenSpec.every((call) => call.messageId === undefined));
  assert.ok(seenBrowser.every((call) => call.messageId === undefined));
});
