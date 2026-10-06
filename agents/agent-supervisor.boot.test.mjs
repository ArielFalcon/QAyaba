import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// Boots the real supervisor entrypoint as a child process with a stub `opencode` executable on
// PATH, so the key hand-off is exercised end to end: a keyless boot waits for configuration, and a
// key delivered later through /restart is what the spawned `opencode serve` receives.

const SUPERVISOR = fileURLToPath(new URL("./agent-supervisor.mjs", import.meta.url));
const SECRET = "fake-gateway-key-for-tests-0001";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function writeStubOpencode(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const file = join(bin, "opencode");
  // Reports whether it received a key, then stays alive like `opencode serve` until signalled.
  writeFileSync(
    file,
    '#!/usr/bin/env node\n' +
      'console.log(`STUB_OPENCODE key=${process.env.OPENCODE_API_KEY ? "present" : "missing"} args=${process.argv.slice(2).join(" ")}`);\n' +
      'const parent = process.ppid;\n' +
      'process.on("SIGTERM", () => process.exit(0));\n' +
      // Never outlive the supervisor, even when a test has to kill it hard.
      'setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);\n',
  );
  chmodSync(file, 0o755);
  return bin;
}

// Collects the supervisor's stdout (its own log lines plus the stub's, which it inherits) and lets a
// test wait for a line without polling.
function watchOutput(child) {
  const lines = [];
  const waiters = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (waiter.pattern.test(line)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  });
  return {
    lines,
    next(pattern) {
      const seen = lines.find((line) => pattern.test(line));
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ pattern, resolve }));
    },
  };
}

async function withSupervisor(env, scenario, { config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-boot-"));
  const port = await freePort();
  if (config) {
    writeFileSync(join(dir, "opencode.json"), JSON.stringify(config));
    env = { ...env, OPENCODE_CONFIG: join(dir, "opencode.json") };
  }
  const child = spawn(process.execPath, [SUPERVISOR], {
    env: {
      PATH: `${writeStubOpencode(dir)}${delimiter}${process.env.PATH}`,
      HOME: dir,
      CODEX_HOME: join(dir, "codex"),
      AGENT_SUPERVISOR_PORT: String(port),
      AGENT_RUNTIME_MODE: "single",
      AGENT_SINGLE_PROVIDER: "opencode",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const output = watchOutput(child);
  const listening = output.next(/listening on/);
  try {
    await listening;
    await scenario({ base: `http://127.0.0.1:${port}`, output });
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

const providers = async (base) => (await (await fetch(`${base}/providers`)).json()).providers;

test("a supervisor booted without a key waits for configuration and does not start opencode", async () => {
  await withSupervisor({ OPENCODE_API_KEY: "" }, async ({ base, output }) => {
    const state = (await providers(base)).opencode;

    assert.equal(state.status, "needs_config");
    assert.equal(state.configured, false);
    assert.ok(!output.lines.some((line) => line.startsWith("STUB_OPENCODE")), "no opencode process without a key");
  });
});

test("a key delivered through /restart starts opencode serve with that key", async () => {
  await withSupervisor({ OPENCODE_API_KEY: "" }, async ({ base, output }) => {
    const started = output.next(/^STUB_OPENCODE/);

    const res = await fetch(`${base}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "opencode", apiKey: SECRET }),
    });
    const startedLine = await started;

    assert.equal(res.status, 200);
    assert.match(startedLine, /key=present/);
    assert.match(startedLine, /\bserve\b/);
    const state = (await providers(base)).opencode;
    assert.equal(state.configured, true);
    assert.notEqual(state.status, "needs_config");
  });
});

test("a key already present at boot starts opencode without any restart", async () => {
  await withSupervisor({ OPENCODE_API_KEY: SECRET }, async ({ output }) => {
    const line = await output.next(/^STUB_OPENCODE/);

    assert.match(line, /key=present/);
  });
});

// The effective OpenCode config declares the LLM gateway; the supervisor reports healthy only once
// that gateway has accepted the key. A stub gateway on loopback stands in for it.
const gatewayConfig = (baseURL) => ({
  provider: { corp: { npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey: "{env:OPENCODE_API_KEY}" }, models: {} } },
  enabled_providers: ["corp"],
});

async function withGateway(statusFor, scenario) {
  const seen = [];
  const server = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(statusFor(req)).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await scenario({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, seen });
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}

// opencode is reported "starting" until its readiness check settles.
async function settled(base) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = (await providers(base)).opencode;
    if (state.status !== "starting" || Date.now() > deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const quick = { AGENT_READY_DELAY_MS: "20" };

test("a gateway that accepts the key makes opencode healthy, and the key never leaves through /providers", async () => {
  await withGateway(() => 200, async ({ baseURL, seen }) => {
    await withSupervisor({ ...quick, OPENCODE_API_KEY: SECRET }, async ({ base }) => {
      const state = await settled(base);

      assert.equal(state.status, "healthy");
      assert.deepEqual(seen.map((s) => [s.method, s.url, s.authorization]), [["GET", "/v1/models", `Bearer ${SECRET}`]]);
      assert.ok(!JSON.stringify(await providers(base)).includes(SECRET));
    }, { config: gatewayConfig(baseURL) });
  });
});

test("a gateway that rejects the key fails opencode with that reason", async () => {
  await withGateway(() => 401, async ({ baseURL }) => {
    await withSupervisor({ ...quick, OPENCODE_API_KEY: SECRET }, async ({ base }) => {
      const state = await settled(base);

      assert.equal(state.status, "failed");
      assert.match(state.error, /key rejected by the LLM gateway/);
      assert.ok(!JSON.stringify(state).includes(SECRET));
    }, { config: gatewayConfig(baseURL) });
  });
});

test("a gateway that cannot be reached fails opencode with that reason", async () => {
  const closed = await freePort();
  await withSupervisor({ ...quick, OPENCODE_API_KEY: SECRET }, async ({ base }) => {
    const state = await settled(base);

    assert.equal(state.status, "failed");
    assert.match(state.error, /LLM gateway unreachable/);
  }, { config: gatewayConfig(`http://127.0.0.1:${closed}/v1`) });
});

test("the key delivered through /restart is the one the gateway is asked to accept", async () => {
  await withGateway((req) => (req.headers.authorization === `Bearer ${SECRET}` ? 200 : 401), async ({ baseURL, seen }) => {
    await withSupervisor({ ...quick, OPENCODE_API_KEY: "" }, async ({ base }) => {
      assert.equal((await providers(base)).opencode.status, "needs_config");
      assert.deepEqual(seen, [], "nothing is checked while there is no key");

      await fetch(`${base}/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "opencode", apiKey: SECRET }) });
      const state = await settled(base);

      assert.equal(state.status, "healthy");
      assert.equal(seen.at(-1).authorization, `Bearer ${SECRET}`);
    }, { config: gatewayConfig(baseURL) });
  });
});

test("a config that declares no gateway keeps opencode healthy without any check", async () => {
  await withSupervisor({ ...quick, OPENCODE_API_KEY: SECRET }, async ({ base }) => {
    assert.equal((await settled(base)).status, "healthy");
  }, { config: { agent: {} } });
});
