import { test } from "node:test";
import assert from "node:assert/strict";
import { callCodeGraph } from "./codegraph-client.mjs";

const context = { sessionID: "ses-1", agent: "qa-generator", abort: new AbortController().signal };
const env = { QA_TOOLS_TOKEN: "service-token" };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return answer instanceof Error ? Promise.reject(answer) : answer;
  };
  return { fn, calls };
}

test("a query carries the session and agent the runtime reports, the action and its own arguments, and the service token, and never a project", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true, result: "{}", truncated: false, callsLeft: 39 }));
  const out = await callCodeGraph({ action: "search_graph", args: { name_pattern: ".*Store.*", project: "another-app", depth: 3 }, context, env, fetchFn: fn });
  assert.equal(calls[0].url, "http://orchestrator:459/internal/codegraph");
  assert.equal(calls[0].init.headers.authorization, "Bearer service-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionID: "ses-1", agent: "qa-generator", action: "search_graph", name_pattern: ".*Store.*" });
  assert.deepEqual(JSON.parse(out), { ok: true, result: "{}", truncated: false, callsLeft: 39 });
});

test("without the service token nothing is sent, and a transport failure says nothing of its address", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
  assert.equal(JSON.parse(await callCodeGraph({ action: "trace_path", args: { function_name: "f" }, context, env: {}, fetchFn: fn })).code, "not-configured");
  assert.equal(calls.length, 0);
  const failing = fakeFetch(new Error("connect ECONNREFUSED 10.0.0.7:459 authorization=Bearer service-token"));
  const out = await callCodeGraph({ action: "get_code_snippet", args: { qualified_name: "a.b" }, context, env, fetchFn: failing.fn });
  assert.equal(JSON.parse(out).code, "unreachable");
  assert.ok(!out.includes("10.0.0.7") && !out.includes("service-token"));
});

test("an answer that is not JSON is a bad response with its status", async () => {
  const { fn } = fakeFetch(new Response("<html>", { status: 502 }));
  const out = JSON.parse(await callCodeGraph({ action: "search_graph", args: { query: "x" }, context, env, fetchFn: fn }));
  assert.equal(out.code, "bad-response");
  assert.match(out.message, /502/);
});
