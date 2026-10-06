import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function withSupervisor(env, scenario) {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-boot-"));
  const port = await freePort();
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
