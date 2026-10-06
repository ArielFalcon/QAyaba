import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_MISMATCH_HERE, OpenCodeRuntimeStrategy, keyFingerprint, type SupervisorFetch } from "./opencode-strategy";
import type { AgentProviderHealth } from "./types";

const SUPERVISOR = "http://agents:4097";

interface Recorded {
  url: string;
  method?: string;
  body?: string;
}

// A supervisor reached through the injected HTTP call: answers /providers with the given state and
// records what it was sent.
function supervisorReporting(state: (Partial<AgentProviderHealth> & { keyFingerprint?: string }) | undefined, sent: Recorded[] = []) {
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

test("a supervisor that holds the key and a process that holds it too report healthy", async () => {
  const health = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" },
    supervisorReporting({ status: "healthy", configured: true }),
  ).health();

  assert.equal(health.status, "healthy");
  assert.equal(health.configured, true);
});

// The orchestrator masks the key in logs and error output from its own environment, and its
// onboarding guard reads it from there: a key only the supervisor holds protects nothing here.
test("a supervisor holding a key this process lacks reports needs_config and asks for the key again", async () => {
  for (const state of [{ status: "healthy" }, { status: "starting" }, { status: "failed", error: "opencode exited 1" }] as const) {
    const health = await strategy(
      { AGENT_SUPERVISOR_URL: SUPERVISOR },
      supervisorReporting({ ...state, configured: true }),
    ).health();

    assert.equal(health.status, "needs_config", state.status);
    assert.equal(health.configured, false);
    assert.ok(health.error && health.error.length > 0, "the operator is told why");
  }
});

// The agent service reports a fingerprint of the key it holds (agents/agent-supervisor.mjs keyFingerprint;
// the same known answer is pinned there). A key left over in this process's environment (an
// orchestrator-only restart reads slim/.env again) is not the key the agent runs with, so the key this
// process masks in logs would not be the one in use.
test("the key fingerprint is the first 12 hex characters of the key's SHA-256", () => {
  assert.equal(keyFingerprint("abc"), "ba7816bf8f01");
});

test("a process that holds the same key as the supervisor reports the supervisor's state, without any fingerprint", async () => {
  const health = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "todays-key" },
    supervisorReporting({ status: "healthy", configured: true, keyFingerprint: keyFingerprint("todays-key") }),
  ).health();

  assert.deepEqual(health, { provider: "opencode", status: "healthy", configured: true });
});

test("a process that holds another key than the supervisor asks for the key again, and names neither", async () => {
  for (const state of [{ status: "healthy" }, { status: "starting" }, { status: "degraded", error: "unverified" }] as const) {
    const health = await strategy(
      { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "yesterdays-key" },
      supervisorReporting({ ...state, configured: true, keyFingerprint: keyFingerprint("todays-key") }),
    ).health();

    assert.equal(health.status, "needs_config", state.status);
    assert.equal(health.configured, false);
    assert.equal(health.error, KEY_MISMATCH_HERE);
    assert.ok(!JSON.stringify(health).includes("yesterdays-key") && !JSON.stringify(health).includes("todays-key"));
  }
});

test("a supervisor that reports no fingerprint leaves the comparison out", async () => {
  const health = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "any-key" },
    supervisorReporting({ status: "healthy", configured: true }),
  ).health();

  assert.equal(health.status, "healthy");
});

test("a supervisor fingerprint that is not a string is an unusable state, never a match", async () => {
  const health = await strategy(
    { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" },
    async () => ({ ok: true, status: 200, json: async () => ({ providers: { opencode: { provider: "opencode", status: "healthy", configured: true, keyFingerprint: 12 } } }) }),
  ).health();

  assert.equal(health.status, "failed");
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

test("an unreachable supervisor is a failure with its cause, never a missing key, whether or not a key is held locally", async () => {
  for (const env of [{ AGENT_SUPERVISOR_URL: SUPERVISOR }, { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" }]) {
    const health = await strategy(env, unreachable).health();

    assert.equal(health.status, "failed");
    assert.equal(health.configured, Boolean(env.OPENCODE_API_KEY));
    assert.match(health.error ?? "", /ECONNREFUSED/);
  }
});

test("a supervisor answering with an error status is a failure carrying the status", async () => {
  const unavailable = async () => ({ ok: false, status: 503, json: async () => ({}) });

  for (const env of [{ AGENT_SUPERVISOR_URL: SUPERVISOR }, { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" }]) {
    const health = await strategy(env, unavailable).health();

    assert.equal(health.status, "failed");
    assert.match(health.error ?? "", /503/);
  }
});

// The injected signal stands for the health deadline, so no test waits on a real clock.
function withDeadline(env: Record<string, string | undefined>, fetchImpl: SupervisorFetch) {
  const deadline = new AbortController();
  const supervised = new OpenCodeRuntimeStrategy({ env, fetchImpl, timeoutSignal: () => deadline.signal });
  return { supervised, expire: () => deadline.abort(new Error("deadline reached")) };
}

test("a supervisor that never answers fails once the deadline passes, whatever the fetch does with the signal", async () => {
  const honoursSignal: SupervisorFetch = (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const ignoresSignal: SupervisorFetch = () => new Promise(() => {});

  for (const fetchImpl of [honoursSignal, ignoresSignal]) {
    for (const env of [{ AGENT_SUPERVISOR_URL: SUPERVISOR }, { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" }]) {
      const { supervised, expire } = withDeadline(env, fetchImpl);
      const pending = supervised.health();
      expire();
      const health = await pending;

      assert.equal(health.status, "failed");
      assert.match(health.error ?? "", /deadline reached/);
    }
  }
});

test("a response whose body never arrives fails once the deadline passes", async () => {
  const headersOnly: SupervisorFetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  const { supervised, expire } = withDeadline({ AGENT_SUPERVISOR_URL: SUPERVISOR }, headersOnly);
  const pending = supervised.health();
  await new Promise((resolve) => setImmediate(resolve));
  expire();

  assert.equal((await pending).status, "failed");
});

test("a supervisor answer that is not usable state is a failure, never a missing key", async () => {
  const answers: Array<[string, () => Promise<unknown>]> = [
    ["not JSON", async () => { throw new SyntaxError("Unexpected token < in JSON"); }],
    ["null", async () => null],
    ["a string", async () => "ok"],
    ["a list", async () => []],
    ["no providers", async () => ({})],
    ["providers that is null", async () => ({ providers: null })],
    ["an entry that is not an object", async () => ({ providers: { opencode: "healthy" } })],
    ["an entry without configured", async () => ({ providers: { opencode: { provider: "opencode", status: "healthy" } } })],
    ["an entry with a configured that is not a boolean", async () => ({ providers: { opencode: { provider: "opencode", status: "healthy", configured: "yes" } } })],
    ["an entry without a status", async () => ({ providers: { opencode: { provider: "opencode", configured: true } } })],
    ["an entry with an unknown status", async () => ({ providers: { opencode: { provider: "opencode", status: "great", configured: true } } })],
  ];

  for (const [label, json] of answers) {
    for (const env of [{ AGENT_SUPERVISOR_URL: SUPERVISOR }, { AGENT_SUPERVISOR_URL: SUPERVISOR, OPENCODE_API_KEY: "k" }]) {
      const health = await strategy(env, async () => ({ ok: true, status: 200, json })).health();

      assert.equal(health.status, "failed", `${label} (key held: ${Boolean(env.OPENCODE_API_KEY)})`);
      assert.equal(health.configured, Boolean(env.OPENCODE_API_KEY));
      assert.ok(health.error && health.error.length > 0, `${label} carries a reason`);
    }
  }
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

test("a restart reports the supervisor's state without its key fingerprint", async () => {
  const env: Record<string, string | undefined> = { AGENT_SUPERVISOR_URL: SUPERVISOR };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ health: { provider: "opencode", status: "starting", configured: true, keyFingerprint: keyFingerprint("todays-key") } }) });

  const health = await new OpenCodeRuntimeStrategy({ env, fetchImpl, dispose: () => {} }).restart({ apiKey: "todays-key" });

  assert.deepEqual(health, { provider: "opencode", status: "starting", configured: true });
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
