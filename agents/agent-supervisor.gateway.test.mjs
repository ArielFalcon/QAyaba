import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayTargets, readOpencodeConfig, useEnvProxy, verifyGateways } from "./agent-supervisor.mjs";

// The supervisor reports `healthy` only once the key it holds has been accepted by the LLM gateway
// the effective OpenCode config declares. The HTTP call is injected, so nothing here touches a network.

const KEY = "gateway-key-0001-never-to-be-echoed";

const provider = (extra = {}) => ({
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: "https://llm.example.test/v1", apiKey: "{env:OPENCODE_API_KEY}", ...extra },
  models: {},
});
const target = (id = "corp", url = "https://llm.example.test/v1/models") => ({ id, url, key: KEY });

const answering = (status) => async () => ({ status, ok: status >= 200 && status < 300, body: { cancel: async () => {} } });

test("a provider with a baseURL and a key read from the environment is a gateway to check", () => {
  const targets = gatewayTargets({ provider: { corp: provider() } }, { OPENCODE_API_KEY: KEY });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "corp");
  assert.equal(targets[0].url, "https://llm.example.test/v1/models");
  assert.equal(targets[0].key, KEY);
});

test("a trailing slash on the baseURL does not double up in the model list URL", () => {
  const targets = gatewayTargets({ provider: { corp: provider({ baseURL: "https://llm.example.test/v1///" }) } }, { OPENCODE_API_KEY: KEY });

  assert.equal(targets[0].url, "https://llm.example.test/v1/models");
});

test("the key sent to a gateway is the one that provider is configured to read", () => {
  const config = { provider: { corp: provider({ apiKey: "{env:CORP_KEY}" }) } };

  const targets = gatewayTargets(config, { OPENCODE_API_KEY: KEY, CORP_KEY: "the-corp-one" });

  assert.equal(targets[0].key, "the-corp-one");
});

test("a provider that does not read a key from the environment is never sent the pasted one", () => {
  const withoutKey = { provider: { corp: provider({ apiKey: undefined }) } };
  const literal = { provider: { corp: provider({ apiKey: "{file:/run/key}" }) } };
  const unset = { provider: { corp: provider({ apiKey: "{env:CORP_KEY}" }) } };
  const env = { OPENCODE_API_KEY: KEY };

  for (const config of [withoutKey, literal, unset]) assert.deepEqual(gatewayTargets(config, env), []);
});

test("providers without a baseURL or that the config disables are not checked", () => {
  const env = { OPENCODE_API_KEY: KEY };
  const noUrl = { provider: { corp: provider({ baseURL: undefined }) } };
  const notEnabled = { provider: { corp: provider(), other: provider() }, enabled_providers: ["other"] };
  const disabled = { provider: { corp: provider() }, disabled_providers: ["corp"] };

  assert.deepEqual(gatewayTargets(noUrl, env), []);
  assert.deepEqual(gatewayTargets(notEnabled, env).map((t) => t.id), ["other"]);
  assert.deepEqual(gatewayTargets(disabled, env), []);
  assert.deepEqual(gatewayTargets(undefined, env), []);
  assert.deepEqual(gatewayTargets({}, env), []);
});

test("the effective OpenCode config is read from OPENCODE_CONFIG, and an unreadable one is no config", () => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-config-"));
  try {
    const path = join(dir, "opencode.json");
    writeFileSync(path, JSON.stringify({ provider: { corp: provider() } }));
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");

    assert.ok(readOpencodeConfig({ OPENCODE_CONFIG: path }).provider.corp);
    assert.equal(readOpencodeConfig({ OPENCODE_CONFIG: broken }), undefined);
    assert.equal(readOpencodeConfig({ OPENCODE_CONFIG: join(dir, "absent.json") }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gateway that accepts the key makes the provider healthy, asked for its model list with that key", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, authorization: init.headers.authorization, redirect: init.redirect });
    return answering(200)();
  };

  const outcome = await verifyGateways([target()], { fetchImpl });

  assert.equal(outcome.status, "healthy");
  assert.equal(outcome.error, undefined);
  assert.deepEqual(sent, [{ url: "https://llm.example.test/v1/models", method: "GET", authorization: `Bearer ${KEY}`, redirect: "manual" }]);
});

test("a gateway that rejects the key fails the provider with that reason and never echoes the key", async () => {
  for (const status of [401, 403]) {
    const outcome = await verifyGateways([target()], { fetchImpl: answering(status) });

    assert.equal(outcome.status, "failed", String(status));
    assert.match(outcome.error, /key rejected by the LLM gateway/);
    assert.ok(!JSON.stringify(outcome).includes(KEY));
  }
});

test("a gateway that cannot be reached fails the provider with that reason and never echoes the key", async () => {
  const refused = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ECONNREFUSED while sending ${KEY}`), { code: "ECONNREFUSED" }) });
  };

  const outcome = await verifyGateways([target()], { fetchImpl: refused });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /LLM gateway unreachable/);
  assert.match(outcome.error, /ECONNREFUSED/);
  assert.ok(!JSON.stringify(outcome).includes(KEY));
});

test("a gateway that never answers fails once the deadline passes, whatever the fetch does with the signal", async () => {
  const deadline = new AbortController();
  const hangs = () => new Promise(() => {});

  const pending = verifyGateways([target()], { fetchImpl: hangs, signalFor: () => deadline.signal });
  deadline.abort(new Error("deadline reached"));
  const outcome = await pending;

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /LLM gateway unreachable/);
});

test("a gateway that answers something other than accept or reject leaves the key unverified, not failed", async () => {
  for (const status of [301, 404, 429, 500, 503]) {
    const outcome = await verifyGateways([target()], { fetchImpl: answering(status) });

    assert.equal(outcome.status, "degraded", String(status));
    assert.ok(outcome.error.includes(String(status)), "the answer is named");
  }
});

test("with several gateways a rejected key outranks an unreachable one, which outranks an unverified one", async () => {
  const byHost = (answers) => async (url) => {
    const answer = answers.find(([host]) => url.includes(host))[1];
    if (answer === "down") throw new TypeError("fetch failed");
    return answering(answer)();
  };
  const targets = [target("a", "https://a.test/models"), target("b", "https://b.test/models"), target("c", "https://c.test/models")];

  const rejected = await verifyGateways(targets, { fetchImpl: byHost([["a.test", 200], ["b.test", "down"], ["c.test", 401]]) });
  const unreachable = await verifyGateways(targets, { fetchImpl: byHost([["a.test", 200], ["b.test", "down"], ["c.test", 404]]) });
  const unverified = await verifyGateways(targets, { fetchImpl: byHost([["a.test", 200], ["b.test", 404], ["c.test", 200]]) });
  const allGood = await verifyGateways(targets, { fetchImpl: byHost([["a.test", 200], ["b.test", 200], ["c.test", 204]]) });

  assert.match(rejected.error, /key rejected/);
  assert.match(unreachable.error, /unreachable/);
  assert.equal(unverified.status, "degraded");
  assert.equal(allGood.status, "healthy");
});

test("the provider whose gateway failed is named, so the operator knows which one to look at", async () => {
  const outcome = await verifyGateways([target("corp-eu")], { fetchImpl: answering(401) });

  assert.ok(outcome.error.includes("corp-eu"));
});

test("proxy settings of the environment are applied to the gateway call when this Node can", () => {
  const applied = [];
  const env = { HTTPS_PROXY: "http://proxy.example.test:3128" };

  const honoured = useEnvProxy({ setGlobalProxyFromEnv: (e) => applied.push(e) }, env);
  const unsupported = useEnvProxy({}, env);

  assert.equal(honoured, true);
  assert.deepEqual(applied, [env]);
  assert.equal(unsupported, false);
});

// On a Node without http.setGlobalProxyFromEnv the check goes direct. On a network that forces a
// proxy that is a transport error the proxy would have avoided, so it says nothing about the key.
const refusedDirect = async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) });
};
const PROXY_ENV = { HTTPS_PROXY: "http://proxy.example.test:3128" };

test("a transport error with a proxy configured but not applicable on this Node leaves the key unverified, not failed", async () => {
  const outcome = await verifyGateways([target()], { fetchImpl: refusedDirect, proxyHonoured: false, env: PROXY_ENV });

  assert.equal(outcome.status, "degraded");
  assert.match(outcome.error, /not verified/);
  assert.match(outcome.error, /no proxy support/);
  assert.doesNotMatch(outcome.error, /unreachable/);
  assert.ok(outcome.error.includes("corp"), "the provider is named");
  assert.ok(!JSON.stringify(outcome).includes(KEY));
});

test("the same transport error is unreachable when this Node applies the proxy", async () => {
  const outcome = await verifyGateways([target()], { fetchImpl: refusedDirect, proxyHonoured: true, env: PROXY_ENV });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /unreachable/);
});

test("without a proxy in the environment a Node that cannot apply one still reports an unreachable gateway", async () => {
  const outcome = await verifyGateways([target()], { fetchImpl: refusedDirect, proxyHonoured: false, env: {} });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /unreachable/);
});

test("a gateway host that NO_PROXY exempts is reached direct, so a transport error there is unreachable", async () => {
  const env = { ...PROXY_ENV, NO_PROXY: "localhost,.example.test" };

  const outcome = await verifyGateways([target("corp", "https://llm.example.test/v1/models")], { fetchImpl: refusedDirect, proxyHonoured: false, env });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /unreachable/);
});

test("NO_PROXY entries match the host exactly, as a domain suffix or as a wildcard, with or without a port", async () => {
  const exempt = ["llm.example.test", "example.test", ".example.test", "*.example.test", "llm.example.test:443", "*"];
  const notExempt = ["other.test", "m.example.test", "llm.example.test:8443", "ample.test"];
  const run = async (noProxy) =>
    (await verifyGateways([target("corp", "https://llm.example.test/v1/models")], { fetchImpl: refusedDirect, proxyHonoured: false, env: { ...PROXY_ENV, NO_PROXY: noProxy } })).status;

  for (const entry of exempt) assert.equal(await run(entry), "failed", `exempt: ${entry}`);
  for (const entry of notExempt) assert.equal(await run(entry), "degraded", `not exempt: ${entry}`);
});

test("only the proxy variable for the gateway's scheme counts, in either case", async () => {
  const run = async (env, url) => (await verifyGateways([target("corp", url)], { fetchImpl: refusedDirect, proxyHonoured: false, env })).status;

  assert.equal(await run({ HTTP_PROXY: "http://p:1" }, "https://llm.example.test/models"), "failed");
  assert.equal(await run({ https_proxy: "http://p:1" }, "https://llm.example.test/models"), "degraded");
  assert.equal(await run({ HTTP_PROXY: "http://p:1" }, "http://llm.example.test/models"), "degraded");
  assert.equal(await run({ http_proxy: "http://p:1" }, "http://llm.example.test/models"), "degraded");
  assert.equal(await run({ HTTPS_PROXY: "" }, "https://llm.example.test/models"), "failed");
});

test("a gateway that answers is judged on its answer whatever this Node does about proxies", async () => {
  const rejected = await verifyGateways([target()], { fetchImpl: answering(401), proxyHonoured: false, env: PROXY_ENV });
  const accepted = await verifyGateways([target()], { fetchImpl: answering(200), proxyHonoured: false, env: PROXY_ENV });

  assert.equal(rejected.status, "failed");
  assert.equal(accepted.status, "healthy");
});

test("an unreachable gateway outranks one that is only unverified for want of proxy support", async () => {
  const byHost = async (url) => {
    if (url.includes("a.test")) return refusedDirect();
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
  };
  const env = { ...PROXY_ENV, NO_PROXY: "b.test" };

  const outcome = await verifyGateways([target("a", "https://a.test/models"), target("b", "https://b.test/models")], { fetchImpl: byHost, proxyHonoured: false, env });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /unreachable/);
  assert.ok(outcome.error.includes("b"));
});
