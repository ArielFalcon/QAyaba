import { test } from "node:test";
import assert from "node:assert/strict";
import { callRunSpec, endpointOf } from "./run-spec-client.mjs";

const context = { sessionID: "ses-1", agent: "qa-generator", abort: new AbortController().signal };
const env = { QA_TOOLS_TOKEN: "service-token" };

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return answer instanceof Error ? Promise.reject(answer) : answer;
  };
  return { fn, calls };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the call carries the session and agent the runtime reports, the model's path and filter, and the service token", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true, report: { status: "passed", tests: [] } }));
  const out = await callRunSpec({ args: { path: "flows/a.spec.ts", grep: "adds" }, context, env, fetchFn: fn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://orchestrator:459/internal/run-spec");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer service-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionID: "ses-1", agent: "qa-generator", path: "flows/a.spec.ts", grep: "adds" });
  assert.deepEqual(JSON.parse(out), { ok: true, report: { status: "passed", tests: [] } });
});

test("a call with no filter sends none", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true, report: {} }));
  await callRunSpec({ args: { path: "a.spec.ts" }, context, env, fetchFn: fn });
  assert.equal("grep" in JSON.parse(calls[0].init.body), false);
});

test("the endpoint follows QA_TOOLS_PORT, and QA_TOOLS_URL wins when given", () => {
  assert.equal(endpointOf({ QA_TOOLS_PORT: "4590" }), "http://orchestrator:4590/internal/run-spec");
  assert.equal(endpointOf({ QA_TOOLS_URL: "http://host.docker.internal:459/" }), "http://host.docker.internal:459/internal/run-spec");
});

test("a refusal comes back as the orchestrator said it, with its status never turned into a throw", async () => {
  const { fn } = fakeFetch(jsonResponse({ ok: false, code: "no-calls", message: "the 8 run_spec calls of this run are spent", budget: { callsLeft: 0 } }, 429));
  const out = JSON.parse(await callRunSpec({ args: { path: "a.spec.ts" }, context, env, fetchFn: fn }));
  assert.equal(out.ok, false);
  assert.equal(out.code, "no-calls");
});

test("without the service token nothing is sent", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({}));
  const out = JSON.parse(await callRunSpec({ args: { path: "a.spec.ts" }, context, env: { QA_TOOLS_TOKEN: "  " }, fetchFn: fn }));
  assert.equal(calls.length, 0);
  assert.equal(out.code, "not-configured");
});

test("an unreachable orchestrator and an unreadable answer are said without quoting the transport", async () => {
  const unreachable = JSON.parse(await callRunSpec({ args: { path: "a.spec.ts" }, context, env, fetchFn: fakeFetch(new Error("connect ECONNREFUSED 10.0.0.5:459 with Bearer service-token")).fn }));
  assert.equal(unreachable.code, "unreachable");
  assert.doesNotMatch(JSON.stringify(unreachable), /10\.0\.0\.5|service-token/);

  const garbled = JSON.parse(await callRunSpec({ args: { path: "a.spec.ts" }, context, env, fetchFn: fakeFetch(new Response("<html>bad gateway</html>", { status: 502 })).fn }));
  assert.equal(garbled.code, "bad-response");
  assert.doesNotMatch(JSON.stringify(garbled), /bad gateway/);
});

test("the runtime's own abort stops the wait", async () => {
  const controller = new AbortController();
  const fn = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const pending = callRunSpec({ args: { path: "a.spec.ts" }, context: { ...context, abort: controller.signal }, env, fetchFn: fn });
  controller.abort();
  const out = JSON.parse(await pending);
  assert.equal(out.code, "unreachable");
});

test("the endpoint of another tool differs by its path alone", () => {
  assert.equal(endpointOf({ QA_TOOLS_PORT: "4590" }, "/internal/authbrowser"), "http://orchestrator:4590/internal/authbrowser");
});
