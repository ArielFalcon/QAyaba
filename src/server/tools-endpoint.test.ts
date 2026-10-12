import { test } from "node:test";
import assert from "node:assert/strict";
import { ClosedLoopRegistry } from "@contexts/qa-run-orchestration/infrastructure/closed-loop-registry";
import { RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability";
import type { RunSpecRequest, RunSpecResponse } from "@contexts/test-execution/application/run-spec.use-case";
import { DEFAULT_TOOLS_PORT, handleToolsRequest, resolveToolsPort, resolveToolsToken, type ToolsRequest } from "./tools-endpoint";

const TOKEN = "service-token-for-tests";

function liveRegistry(call: (request: RunSpecRequest) => Promise<RunSpecResponse> = async () => ({ ok: true, report: { status: "passed", tests: [], budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 1 } } })) {
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

  const registry = liveRegistry(async (call) => (call.agent === "qa-generator" ? { ok: true, report: { status: "passed", tests: [], budget: { callsLeft: 0, msLeft: undefined, devWritesLeft: 0 } } } : { ok: false, code: "wrong-agent", message: "run_spec is available to the generator only", budget: { callsLeft: 0, msLeft: undefined, devWritesLeft: 0 } }));
  const reviewer = await handle(request({ body: JSON.stringify({ sessionID: "ses-1", agent: "qa-reviewer", path: "a.spec.ts" }) }), registry);
  assert.equal(reviewer.status, 403);
});

test("a call from the generator's session runs and returns the report", async () => {
  const seen: RunSpecRequest[] = [];
  const registry = liveRegistry(async (call) => (seen.push(call), { ok: true, report: { status: "failed", tests: [{ title: "t", status: "failed" }], budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 2 } } }));
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
