import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { openCodeServerEnv, qaToolsEnv, commandFor, redactForResponse, restartProvider, server, OPENCODE_PROVIDER_KEYS } from "./agent-supervisor.mjs";

// Importing agent-supervisor.mjs must NOT start the HTTP server (it is main-guarded). If it did, the
// listening socket would keep this process alive and node:test would hang instead of exiting — so
// reaching these assertions and finishing cleanly is itself the proof that the import is side-effect-free.

test("openCodeServerEnv keeps the password compose provides", () => {
  const out = openCodeServerEnv({ PATH: "/bin", OPENCODE_SERVER_PASSWORD: "from-compose" });
  assert.equal(out.OPENCODE_SERVER_PASSWORD, "from-compose");
  assert.equal(out.PATH, "/bin", "the rest of the environment is passed through");
});

test("openCodeServerEnv generates a strong password when none is set, and the same one for every respawn", () => {
  const warnings = [];
  const first = openCodeServerEnv({}, { warn: (line) => warnings.push(line) });
  const second = openCodeServerEnv({ OPENCODE_SERVER_PASSWORD: "   " }, { warn: (line) => warnings.push(line) });
  assert.ok(first.OPENCODE_SERVER_PASSWORD.length >= 32, "a generated password carries real entropy");
  assert.equal(second.OPENCODE_SERVER_PASSWORD, first.OPENCODE_SERVER_PASSWORD, "a respawned server keeps the password of the first");
  assert.ok(warnings.length >= 1 && warnings.every((line) => !line.includes(first.OPENCODE_SERVER_PASSWORD)), "the warning never carries the value");
  assert.ok(warnings.some((line) => line.includes("OPENCODE_SERVER_PASSWORD")), "the warning says which variable the orchestrator needs");
});

// ─── the run_spec tool authenticates to the orchestrator with a service token ───
test("qaToolsEnv keeps the token compose provides and passes the rest of the environment through", () => {
  const out = qaToolsEnv({ PATH: "/bin", QA_TOOLS_TOKEN: " from-compose " });
  assert.equal(out.QA_TOOLS_TOKEN, "from-compose");
  assert.equal(out.PATH, "/bin");
});

test("qaToolsEnv generates a strong token when none is set, the same one for every respawn, and never prints it", () => {
  const warnings = [];
  const first = qaToolsEnv({}, { warn: (line) => warnings.push(line) });
  const second = qaToolsEnv({ QA_TOOLS_TOKEN: "  " }, { warn: (line) => warnings.push(line) });
  assert.ok(first.QA_TOOLS_TOKEN.length >= 32);
  assert.equal(second.QA_TOOLS_TOKEN, first.QA_TOOLS_TOKEN);
  assert.ok(warnings.length >= 1 && warnings.every((line) => !line.includes(first.QA_TOOLS_TOKEN)));
  assert.ok(warnings.some((line) => line.includes("QA_TOOLS_TOKEN")));
});

test("redactForResponse masks the tools token", () => {
  const previous = process.env.QA_TOOLS_TOKEN;
  process.env.QA_TOOLS_TOKEN = "tools-token-value";
  try {
    assert.doesNotMatch(redactForResponse("rejected tools-token-value"), /tools-token-value/);
  } finally {
    if (previous === undefined) delete process.env.QA_TOOLS_TOKEN;
    else process.env.QA_TOOLS_TOKEN = previous;
  }
});

test("redactForResponse masks the OpenCode server password wherever a CLI echoes it", () => {
  const previous = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_PASSWORD = "s3cret-server-password";
  try {
    const masked = redactForResponse("auth failed for s3cret-server-password at x");
    assert.ok(!masked.includes("s3cret-server-password"));
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previous;
  }
});

// ─── a watched repo's own agent configuration is never loaded ───
// OpenCode resolves its configuration per session directory and merges the directory's opencode.json and
// .opencode/ (agents, plugins, MCP servers, permission overrides) over qayaba's: a repo could re-grant
// the generator a shell, open env reads or run a plugin inside the agents container. The server therefore
// ignores project configuration altogether; only the baseline experiment, which defines its agent that way,
// opts back in, explicitly and for the whole container.
test("the OpenCode server ignores project configuration, whatever the environment says", () => {
  assert.equal(commandFor("opencode", { PATH: "/bin" }).env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(
    commandFor("opencode", { OPENCODE_DISABLE_PROJECT_CONFIG: "false" }).env.OPENCODE_DISABLE_PROJECT_CONFIG,
    "true",
    "a stray value cannot turn the protection off",
  );
});

test("only the explicit baseline opt-in lets the OpenCode server read project configuration", () => {
  assert.equal("OPENCODE_DISABLE_PROJECT_CONFIG" in commandFor("opencode", { AGENT_ALLOW_PROJECT_CONFIG: "true" }).env, false);
  for (const value of ["", "1", "yes", "false", "TRUE "]) {
    assert.equal(
      commandFor("opencode", { AGENT_ALLOW_PROJECT_CONFIG: value }).env.OPENCODE_DISABLE_PROJECT_CONFIG,
      "true",
      `"${value}" is not the opt-in`,
    );
  }
});

// OpenCode runs on any provider its config reads a key for: the supervisor counts every one of them as configuring
// the runtime, and masks every one of them in its answers, so a provider added to opencode.json is never left out.
test("every provider key opencode.json reads configures the OpenCode runtime and is masked in answers", () => {
  const config = readFileSync(new URL("./opencode.json", import.meta.url), "utf8");
  const read = [...config.matchAll(/\{env:([A-Z0-9_]+)\}/g)].map((m) => m[1]).filter((name) => name.endsWith("_API_KEY"));
  /* A config on OpenCode's built-in providers reads none; OPENCODE_API_KEY stays listed for them. */
  assert.ok(OPENCODE_PROVIDER_KEYS.includes("OPENCODE_API_KEY"));
  for (const name of read) {
    assert.ok(OPENCODE_PROVIDER_KEYS.includes(name), `${name} configures the OpenCode runtime`);
    const before = process.env[name];
    process.env[name] = "provider-key-value-123456";
    try {
      assert.equal(redactForResponse("failed with provider-key-value-123456"), "failed with [REDACTED_CREDENTIAL]", `${name} is masked`);
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  }
});

test("the OpenCode server command carries the tools token", () => {
  assert.ok(commandFor("opencode", { PATH: "/bin" }).env.QA_TOOLS_TOKEN);
});

test("the OpenCode server command always runs with a password in its environment", () => {
  const spec = commandFor("opencode", { PATH: "/bin" });
  assert.ok(spec.env.OPENCODE_SERVER_PASSWORD, "serve must never start without one");
});

test("the supervisor serves the OpenCode provider only: an unknown provider is refused", async () => {
  assert.equal(commandFor("other-runtime", {}), undefined, "no command exists for a provider the supervisor does not run");
  for (const provider of ["codex", "other-runtime", ""]) {
    await assert.rejects(() => restartProvider(provider), /provider must be opencode/, provider);
  }
});

test("POST /codex/exec is not a route", async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/codex/exec`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(Object.keys(health.providers), ["opencode"], "health reports the one runtime the supervisor runs");
  } finally {
    server.close();
    await once(server, "close");
  }
});
