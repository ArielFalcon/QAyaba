import { test } from "node:test";
import assert from "node:assert/strict";
import { callAuthBrowser } from "./authbrowser-client.mjs";

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

test("a call carries the session and agent the runtime reports, the action and its arguments, and the service token", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true, page: { url: "https://dev/x", snapshot: "- heading" } }));
  const out = await callAuthBrowser({ action: "navigate", args: { url: "/orders" }, context, env, fetchFn: fn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://orchestrator:459/internal/authbrowser");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer service-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionID: "ses-1", agent: "qa-generator", action: "navigate", url: "/orders" });
  assert.deepEqual(JSON.parse(out), { ok: true, page: { url: "https://dev/x", snapshot: "- heading" } });
});

test("each action sends only the arguments it has", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
  await callAuthBrowser({ action: "snapshot", args: {}, context, env, fetchFn: fn });
  await callAuthBrowser({ action: "click", args: { ref: "e5" }, context, env, fetchFn: fn });
  await callAuthBrowser({ action: "type", args: { ref: "e2", text: "hello", submit: true }, context, env, fetchFn: fn });
  await callAuthBrowser({ action: "type", args: { ref: "e2", text: "again" }, context, env, fetchFn: fn });
  const bodies = calls.map((c) => JSON.parse(c.init.body));
  assert.deepEqual(bodies.map((b) => b.action), ["snapshot", "click", "type", "type"]);
  assert.equal("ref" in bodies[0], false);
  assert.equal(bodies[1].ref, "e5");
  assert.equal(bodies[2].submit, true);
  assert.equal("submit" in bodies[3], false);
});

test("an argument the tool does not declare is not forwarded", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
  await callAuthBrowser({ action: "click", args: { ref: "e1", script: "alert(1)", url: "/x" }, context, env, fetchFn: fn });
  const body = JSON.parse(calls[0].init.body);
  assert.equal("script" in body, false);
  assert.equal("url" in body, false);
});

test("without the service token nothing is sent and the answer names the variable", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
  const out = JSON.parse(await callAuthBrowser({ action: "snapshot", args: {}, context, env: {}, fetchFn: fn }));
  assert.equal(calls.length, 0);
  assert.equal(out.ok, false);
  assert.match(out.message, /QA_TOOLS_TOKEN/);
});

test("an unreachable orchestrator is reported without quoting the transport error", async () => {
  const { fn } = fakeFetch(new Error("connect ECONNREFUSED 10.0.0.5:459 Authorization: Bearer service-token"));
  const out = await callAuthBrowser({ action: "snapshot", args: {}, context, env, fetchFn: fn });
  assert.equal(JSON.parse(out).code, "unreachable");
  assert.doesNotMatch(out, /service-token|10\.0\.0\.5/);
});

test("a refusal from the orchestrator reaches the model as it is, and an unreadable answer is said to be one", async () => {
  const refused = fakeFetch(jsonResponse({ ok: false, code: "blocked", message: "POST /api/x would write to DEV" }, 403));
  assert.deepEqual(JSON.parse(await callAuthBrowser({ action: "click", args: { ref: "e1" }, context, env, fetchFn: refused.fn })), { ok: false, code: "blocked", message: "POST /api/x would write to DEV" });
  const garbage = fakeFetch(new Response("<html>", { status: 502 }));
  assert.equal(JSON.parse(await callAuthBrowser({ action: "snapshot", args: {}, context, env, fetchFn: garbage.fn })).code, "bad-response");
});
