import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeRuntimeStrategy, type SupervisorFetch } from "./opencode-strategy";
import type { AgentProviderHealth } from "./types";

const SUPERVISOR = "http://agents:4097";

interface Recorded {
  url: string;
  method?: string;
  body?: string;
}

// A supervisor reached through the injected HTTP call: answers /providers with the given state and
// records what it was sent.
function supervisorReporting(state: Partial<AgentProviderHealth> | undefined, sent: Recorded[] = []) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ url, method: init?.method, body: init?.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ providers: state ? { opencode: { provider: "opencode", ...state } } : {} }),
    };
  };
}

const unreachable = async () => {
  throw new Error("connect ECONNREFUSED");
};

function strategy(env: Record<string, string | undefined>, fetchImpl: SupervisorFetch) {
  return new OpenCodeRuntimeStrategy({ env, fetchImpl });
}

test("a supervisor that holds the key reports healthy even when this process was started without one", async () => {
  const health = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR },
    supervisorReporting({ status: "healthy", configured: true }),
  ).health();

  assert.equal(health.status, "healthy");
  assert.equal(health.configured, true);
});

test("a supervisor waiting for a key reports needs_config even when this process still holds a stale key", async () => {
  const health = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "yesterdays-key" },
    supervisorReporting({ status: "needs_config", configured: false }),
  ).health();

  assert.equal(health.status, "needs_config");
  assert.equal(health.configured, false);
});

test("the supervisor's failure detail is passed on", async () => {
  const health = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" },
    supervisorReporting({ status: "failed", configured: true, error: "opencode exited 1" }),
  ).health();

  assert.equal(health.status, "failed");
  assert.match(health.error ?? "", /opencode exited 1/);
});

test("an unreachable supervisor with no key held locally reports needs_config", async () => {
  const health = await strategy({ AGENT_SUPERVISOR_URL: SUPERVISOR }, unreachable).health();

  assert.equal(health.status, "needs_config");
  assert.equal(health.configured, false);
});

test("an unreachable supervisor with a key held locally reports the failure and its cause", async () => {
  const health = await strategy({ AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" }, unreachable).health();

  assert.equal(health.status, "failed");
  assert.equal(health.configured, true);
  assert.match(health.error ?? "", /ECONNREFUSED/);
});

test("a supervisor answering with an error status counts as unreachable", async () => {
  const unavailable = async () => ({ ok: false, status: 503, json: async () => ({}) });

  const withoutKey = await strategy({ AGENT_SUPERVISOR_URL: SUPERVISOR }, unavailable).health();
  const withKey = await strategy({ AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" }, unavailable).health();

  assert.equal(withoutKey.status, "needs_config");
  assert.equal(withKey.status, "failed");
  assert.match(withKey.error ?? "", /503/);
});

test("a supervisor that does not list the provider leaves the answer to the local key", async () => {
  const withKey = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" },
    supervisorReporting(undefined),
  ).health();
  const withoutKey = await strategy({ AGENT_SUPERVISOR_URL: SUPERVISOR }, supervisorReporting(undefined)).health();

  assert.equal(withKey.status, "healthy");
  assert.equal(withoutKey.status, "needs_config");
});

test("without a supervisor the local key decides and nothing is requested", async () => {
  const sent: Recorded[] = [];
  const fetchImpl = supervisorReporting({ status: "healthy", configured: true }, sent);

  const withKey = await strategy({ OPENCODE_API_KEY: "k" }, fetchImpl).health();
  const withoutKey = await strategy({}, fetchImpl).health();

  assert.equal(withKey.status, "healthy");
  assert.equal(withoutKey.status, "needs_config");
  assert.deepEqual(sent, []);
});

test("restarting with a key hands it to the supervisor and reports the state it answers with", async () => {
  const sent: Recorded[] = [];
  const env: Record<string, string | undefined> = { AGENT_SUPERVISOR_URL: SUPERVISOR };
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ url, method: init?.method, body: init?.body });
    return { ok: true, status: 200, json: async () => ({ health: { provider: "opencode", status: "starting", configured: true } }) };
  };

  const health = await new OpenCodeRuntimeStrategy({ env, fetchImpl, dispose: () => {} }).restart({ apiKey: "todays-key" });

  assert.equal(health.status, "starting");
  assert.equal(env.OPENCODE_API_KEY, "todays-key");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, "POST");
  assert.ok(sent[0]?.url.startsWith(SUPERVISOR));
  const body = JSON.parse(sent[0]?.body ?? "{}") as { provider?: string; apiKey?: string };
  assert.equal(body.provider, "opencode");
  assert.equal(body.apiKey, "todays-key");
});
