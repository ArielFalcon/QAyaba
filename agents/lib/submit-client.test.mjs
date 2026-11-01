import { test } from "node:test";
import assert from "node:assert/strict";
import { callSubmit } from "./submit-client.mjs";

const context = { sessionID: "ses-1", agent: "qa-reviewer", messageID: "msg-9", abort: new AbortController().signal };
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

test("a call carries the session and agent the runtime reports, the tool, the answer as typed and the service token, and nothing else", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true, message: "accepted" }));
  const answer = { approved: false, corrections: [{ text: "x", severity: "blocking" }] };
  const out = await callSubmit({ tool: "submit_review", answer, context, env, fetchFn: fn });
  assert.equal(calls[0].url, "http://orchestrator:459/internal/submit");
  assert.equal(calls[0].init.headers.authorization, "Bearer service-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionID: "ses-1", agent: "qa-reviewer", messageID: "msg-9", tool: "submit_review", answer });
  assert.deepEqual(JSON.parse(out), { ok: true, message: "accepted" });
});

test("the orchestrator's rejection reaches the model whole, with the path and reason of every error", async () => {
  const rejection = { ok: false, code: "invalid-answer", message: "submit_review was not accepted", errors: [{ path: "corrections.0.severity", reason: "expected blocking or advisory" }] };
  const { fn } = fakeFetch(jsonResponse(rejection, 422));
  const out = await callSubmit({ tool: "submit_review", answer: {}, context, env, fetchFn: fn });
  assert.deepEqual(JSON.parse(out), rejection);
});

test("without the service token nothing is sent, and a transport failure says nothing of its address or the token", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
  assert.equal(JSON.parse(await callSubmit({ tool: "submit_plan", answer: {}, context, env: {}, fetchFn: fn })).code, "not-configured");
  assert.equal(calls.length, 0);
  const failing = fakeFetch(new Error("connect ECONNREFUSED 10.0.0.7:459 authorization=Bearer service-token"));
  const out = await callSubmit({ tool: "submit_plan", answer: {}, context, env, fetchFn: failing.fn });
  assert.equal(JSON.parse(out).code, "unreachable");
  assert.ok(!out.includes("10.0.0.7") && !out.includes("service-token"));
});

test("an answer that is not JSON is a bad response with its status", async () => {
  const { fn } = fakeFetch(new Response("<html>", { status: 502 }));
  const out = JSON.parse(await callSubmit({ tool: "submit_plan", answer: {}, context, env, fetchFn: fn }));
  assert.equal(out.code, "bad-response");
  assert.match(out.message, /502/);
});
