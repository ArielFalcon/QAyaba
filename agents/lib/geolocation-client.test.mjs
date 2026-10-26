import { test } from "node:test";
import assert from "node:assert/strict";
import { callGeolocation } from "./geolocation-client.mjs";

const context = { sessionID: "ses-1", agent: "qa-author", abort: new AbortController().signal };
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

test("a call carries the session and agent the runtime reports, the place and the service token", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true, location: { latitude: 41.3874, longitude: 2.1686 }, scope: "run", place: "barcelona" }));
  const out = await callGeolocation({ args: { place: "barcelona" }, context, env, fetchFn: fn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://orchestrator:459/internal/geolocation");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer service-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionID: "ses-1", agent: "qa-author", place: "barcelona" });
  assert.deepEqual(JSON.parse(out), { ok: true, location: { latitude: 41.3874, longitude: 2.1686 }, scope: "run", place: "barcelona" });
});

test("a point is carried as the two numbers the model chose; an argument the tool does not declare is dropped", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
  await callGeolocation({ args: { latitude: 10, longitude: 20, radius: 5000, script: "x" }, context, env, fetchFn: fn });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.latitude, 10);
  assert.equal(body.longitude, 20);
  assert.equal("radius" in body, false);
  assert.equal("script" in body, false);
});

test("without the service token nothing is sent and the answer names the variable", async () => {
  const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
  const out = await callGeolocation({ args: { place: "barcelona" }, context, env: {}, fetchFn: fn });
  assert.equal(calls.length, 0);
  assert.match(out, /QA_TOOLS_TOKEN/);
  assert.match(out, /not-configured/);
});

test("an unreachable orchestrator and a body it cannot read are answered without leaking either", async () => {
  const unreachable = await callGeolocation({ args: { place: "barcelona" }, context, env, fetchFn: fakeFetch(new Error("connect ECONNREFUSED 10.0.0.2")).fn });
  assert.match(unreachable, /could not reach/);
  assert.equal(unreachable.includes("10.0.0.2"), false);
  const bad = await callGeolocation({ args: { place: "barcelona" }, context, env, fetchFn: fakeFetch(new Response("not json", { status: 502 })).fn });
  assert.match(bad, /bad-response/);
});
