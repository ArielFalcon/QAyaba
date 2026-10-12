import { test } from "node:test";
import assert from "node:assert/strict";
import { ClosedLoopRegistry } from "@contexts/qa-run-orchestration/infrastructure/closed-loop-registry";
import { RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability";
import type { RunSpecRequest, RunSpecResponse } from "@contexts/test-execution/application/run-spec.use-case";
import { AgentBrowserRegistry } from "@contexts/qa-run-orchestration/infrastructure/agent-browser-registry";
import { AgentBrowserCapability, type AgentBrowserRefusalCode } from "@contexts/test-execution/domain/agent-browser-capability";
import type { AgentBrowserRequest, AgentBrowserResponse } from "@contexts/test-execution/application/agent-browser.use-case";
import { AUTHBROWSER_PATH, DEFAULT_TOOLS_PORT, handleToolsRequest, resolveToolsPort, resolveToolsToken, type ToolsRequest } from "./tools-endpoint";

const TOKEN = "service-token-for-tests";

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
  assert.deepEqual(resolveToolsToken({ QA_TOOLS_TOKEN: " abc " }, { warn: (m) => void quiet.push(m) }), { token: "abc", generated: false });
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
