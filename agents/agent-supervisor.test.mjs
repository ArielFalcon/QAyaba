import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSandbox, buildCodexExecArgs, ensureCodexConfig, openCodeServerEnv, qaToolsEnv, commandFor, redactForResponse, codexExecEnv } from "./agent-supervisor.mjs";

// Importing agent-supervisor.mjs must NOT start the HTTP server (it is main-guarded). If it did, the
// listening socket would keep this process alive and node:test would hang instead of exiting — so
// reaching these assertions and finishing cleanly is itself the proof that the import is side-effect-free.

test("resolveSandbox: read-only roles stay read-only; an absent sandbox defaults to workspace-write", () => {
  assert.equal(resolveSandbox("read-only"), "read-only");
  assert.equal(resolveSandbox("workspace-write"), "workspace-write");
  assert.equal(resolveSandbox(undefined), "workspace-write"); // older orchestrator that omits it
});

test("resolveSandbox rejects an unknown value (no `--sandbox` flag-injection)", () => {
  assert.throws(() => resolveSandbox("danger-full-access"), /sandbox must be/);
  assert.throws(() => resolveSandbox("--privileged"), /sandbox must be/);
});

test("buildCodexExecArgs: read-only roles get --sandbox read-only; write roles bypass codex's own sandbox", () => {
  // Read-only roles keep codex's read-only sandbox — the judge/reflector still cannot write.
  const reviewer = buildCodexExecArgs({ cwd: "/repo", sandbox: "read-only" });
  const i = reviewer.indexOf("--sandbox");
  assert.ok(i >= 0 && reviewer[i + 1] === "read-only", "reviewer must run --sandbox read-only");
  assert.ok(!reviewer.includes("--dangerously-bypass-approvals-and-sandbox"), "reviewer must NOT bypass the sandbox");

  // Write roles: codex's OS-sandbox (landlock/seccomp via a user namespace) cannot initialise inside the
  // unprivileged agents container, so write roles bypass it; the container + the orchestrator's out-of-e2e
  // revert are the real boundary (see buildCodexExecArgs in agent-supervisor.mjs). Bypass replaces --sandbox.
  const dflt = buildCodexExecArgs({ cwd: "/repo" });
  assert.ok(dflt.includes("--dangerously-bypass-approvals-and-sandbox"), "an absent sandbox (write-capable) bypasses codex's sandbox");
  assert.ok(!dflt.includes("--sandbox"), "the bypass and --sandbox are mutually exclusive");

  const withModel = buildCodexExecArgs({ cwd: "/repo", model: "gpt-5.4", sandbox: "workspace-write" });
  assert.ok(withModel.includes("--model") && withModel.includes("gpt-5.4"));
});

test("buildCodexExecArgs throws on an invalid sandbox (surfaced as a 400, never spawned)", () => {
  assert.throws(() => buildCodexExecArgs({ cwd: "/repo", sandbox: "nope" }), /sandbox must be/);
});

// ─── T-P0-2: ensureCodexConfig() — supervisor writes 3-field config.toml at boot ───
// AC0.1.1: produces TOML containing [mcp_servers.serena], [mcp_servers.engram],
//          [mcp_servers.playwright] with command/args/env matching opencode.json defs.
//          The engram block MUST contain env.ENGRAM_DATA_DIR = resolved value,
//          NOT the literal {env:ENGRAM_DATA_DIR} placeholder.
// AC0.1.2: second call is byte-identical (idempotent) and throws nothing.
test("ensureCodexConfig: produces TOML with the three expected MCP server blocks", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-test-"));
  const env = { ENGRAM_DATA_DIR: "/data" };
  ensureCodexConfig(codexHome, env);

  const content = readFileSync(join(codexHome, "config.toml"), "utf8");

  // serena block
  assert.ok(content.includes("[mcp_servers.serena]"), "must have [mcp_servers.serena]");
  assert.ok(content.includes('command = "serena"'), "serena command must be 'serena'");
  assert.ok(
    content.includes('"start-mcp-server"') && content.includes('"--transport"') &&
    content.includes('"stdio"') && content.includes('"--context"') && content.includes('"ide-assistant"'),
    "serena args must match opencode.json definition"
  );

  // engram block
  assert.ok(content.includes("[mcp_servers.engram]"), "must have [mcp_servers.engram]");
  assert.ok(content.includes('command = "engram"'), "engram command must be 'engram'");
  assert.ok(
    content.includes('"mcp"') && content.includes('"--tools=agent"'),
    "engram args must include mcp --tools=agent"
  );
  // CRITICAL: env must be RESOLVED value "/data", NOT the literal placeholder
  assert.ok(
    content.includes('ENGRAM_DATA_DIR = "/data"'),
    `engram env.ENGRAM_DATA_DIR must be the resolved value "/data", not the placeholder. Got:\n${content}`
  );
  assert.ok(
    !content.includes("{env:ENGRAM_DATA_DIR}"),
    "config.toml must NOT contain the literal {env:ENGRAM_DATA_DIR} placeholder"
  );

  // playwright block
  assert.ok(content.includes("[mcp_servers.playwright]"), "must have [mcp_servers.playwright]");
  assert.ok(content.includes('command = "npx"'), "playwright command must be 'npx'");
  assert.ok(
    content.includes('"@playwright/mcp"') && content.includes('"--browser"') &&
    content.includes('"chromium"') && content.includes('"--headless"'),
    "playwright args must match opencode.json definition"
  );
});

test("ensureCodexConfig: second call is byte-identical (idempotent) and throws nothing", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-idempotent-"));
  const env = { ENGRAM_DATA_DIR: "/data" };

  ensureCodexConfig(codexHome, env);
  const first = readFileSync(join(codexHome, "config.toml"), "utf8");

  // second call must not throw
  assert.doesNotThrow(() => ensureCodexConfig(codexHome, env));
  const second = readFileSync(join(codexHome, "config.toml"), "utf8");

  assert.equal(first, second, "second call must produce byte-identical content (idempotent)");
});

test("ensureCodexConfig: preserves existing auth content in the file (survives codex-data volume)", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-auth-"));
  const env = { ENGRAM_DATA_DIR: "/data" };

  // Pre-seed auth content that should survive a re-run
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, '[auth]\napi_key = "sk-test-value"\n\n', "utf8");

  // First call must not clobber auth
  ensureCodexConfig(codexHome, env);
  const after = readFileSync(configPath, "utf8");
  assert.ok(
    after.includes('[auth]') && after.includes('api_key = "sk-test-value"'),
    "ensureCodexConfig must preserve existing auth content"
  );
  assert.ok(after.includes("[mcp_servers.serena]"), "must still have mcp_servers after merge");
});

// The lines each [mcp_servers.<name>] table holds, by server name. A table ends at the next header.
function mcpTables(toml) {
  const tables = {};
  let current = null;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\[mcp_servers\.([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      tables[current] = [];
    } else if (/^\[/.test(line)) {
      current = null;
    } else if (current !== null) {
      tables[current].push(line);
    }
  }
  return tables;
}

// What a table assigns to `disabled_tools`, or undefined when it assigns nothing. An array of plain
// TOML strings is also a JSON array.
function disabledToolsOf(tableLines) {
  const line = tableLines.find((l) => /^disabled_tools\s*=/.test(l));
  return line === undefined ? undefined : JSON.parse(line.slice(line.indexOf("=") + 1));
}

// Governance: no pipeline role closes a session, and the memory server's own instructions call the
// session summary mandatory before an agent says it is done. Codex has one config.toml for every role,
// so the denial is made on the engram server itself. The pinned Codex (0.139.0) offers the model no
// tool its `disabled_tools` lists.
test("ensureCodexConfig: the engram table disables the session summary", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-disabled-"));
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data" });

  const tables = mcpTables(readFileSync(join(codexHome, "config.toml"), "utf8"));
  assert.deepEqual(disabledToolsOf(tables.engram), ["mem_session_summary"]);
});

// Governance: a role that authors against live DEV observes it; it never runs code of its own choosing
// in the page, pushes a file into the app or opens a shell through a tool server. OpenCode denies these per
// agent in opencode.json; Codex has one config.toml for every role, so the same tools are disabled on the
// servers themselves. What opencode.json denies the generator is the reference, so the two runtimes cannot
// drift (a tool denied there and offered here is a role that reaches DEV through the other runtime).
// The built-in shell is NOT covered here: Codex cannot restrict the commands of a write role (see
// ensureCodexConfig), so the denial of the built-in shell that opencode.json gives the generator has no Codex counterpart.
test("ensureCodexConfig: the playwright and serena tables disable the tools opencode.json denies the generator", () => {
  const generator = JSON.parse(readFileSync(join(import.meta.dirname, "opencode.json"), "utf8")).agent["qa-generator"];
  const deniedBare = (server, tool) => generator.tools[tool] === false && generator.tools[`${server}_${tool}`] === false;

  const codexHome = mkdtempSync(join(tmpdir(), "codex-authoring-"));
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data" });
  const tables = mcpTables(readFileSync(join(codexHome, "config.toml"), "utf8"));

  const playwright = disabledToolsOf(tables.playwright) ?? [];
  assert.ok(playwright.length > 0, "playwright must disable the tools that run code or push a file");
  for (const tool of playwright) assert.ok(deniedBare("playwright", tool), `Codex disables "${tool}" but opencode.json does not deny it to the generator`);
  for (const tool of ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop"]) {
    assert.ok(playwright.includes(tool), `Codex must disable "${tool}"`);
  }

  const serena = disabledToolsOf(tables.serena) ?? [];
  assert.ok(serena.includes("execute_shell_command"), "serena must not offer a shell");
  for (const tool of serena) assert.ok(deniedBare("serena", tool), `Codex disables "${tool}" but opencode.json does not deny it to the generator`);
});

test("ensureCodexConfig: a config.toml written before the denial is upgraded in place, with one engram table", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-upgrade-"));
  const configPath = join(codexHome, "config.toml");
  // What a codex-data volume holds from an earlier boot: auth, and an engram table with no disabled tools.
  writeFileSync(
    configPath,
    '[auth]\napi_key = "sk-test-value"\n\n' +
      '[mcp_servers.engram]\ncommand = "engram"\nargs = ["mcp", "--tools=agent"]\nenv = { ENGRAM_DATA_DIR = "/old" }\n',
    "utf8",
  );

  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data" });

  const after = readFileSync(configPath, "utf8");
  assert.equal(after.split("[mcp_servers.engram]").length - 1, 1, "the old engram table must be replaced, not duplicated");
  assert.deepEqual(disabledToolsOf(mcpTables(after).engram), ["mem_session_summary"]);
  assert.ok(after.includes('api_key = "sk-test-value"'), "the auth content must survive the upgrade");
});

// T-P0-3: sandbox regression guard — read-only roles resolve to read-only, generator to workspace-write.
// AC0.1.3 RELAXED: the per-role MCP exclusion is satisfied by the per-role sandbox boundary,
// NOT by a per-role MCP config. This test pins the contract so it can never silently regress.
test("read-only roles resolve --sandbox read-only; write roles bypass codex's sandbox", () => {
  // Read-only roles: reviewer, reflector — keep codex's read-only sandbox; they never write.
  const reviewer = buildCodexExecArgs({ cwd: "/repo", sandbox: "read-only" });
  const ri = reviewer.indexOf("--sandbox");
  assert.ok(ri >= 0, "--sandbox flag must be present for reviewer");
  assert.equal(reviewer[ri + 1], "read-only", "reviewer must run --sandbox read-only");
  assert.ok(!reviewer.includes("--dangerously-bypass-approvals-and-sandbox"), "reviewer must NOT bypass");

  // Write role: bypass codex's redundant in-container sandbox (it cannot init unprivileged). The
  // container isolation + the orchestrator's out-of-e2e revert remain the boundary.
  const generator = buildCodexExecArgs({ cwd: "/repo", sandbox: "workspace-write" });
  assert.ok(generator.includes("--dangerously-bypass-approvals-and-sandbox"), "generator (write) bypasses codex's sandbox");
  assert.ok(!generator.includes("--sandbox"), "generator must not also pass --sandbox (mutually exclusive)");

  // Default (no sandbox) is write-capable → same bypass — backward compat for an older orchestrator.
  const defaultArgs = buildCodexExecArgs({ cwd: "/repo" });
  assert.ok(defaultArgs.includes("--dangerously-bypass-approvals-and-sandbox"), "default (no sandbox) bypasses codex's sandbox");
});

// ─── `opencode serve` is never started unsecured ───
// The server is reachable from every container on the compose network and from the host when a port is
// published; without OPENCODE_SERVER_PASSWORD it accepts anyone. The supervisor therefore always hands the
// child a password: the one compose provides (shared with the orchestrator, which authenticates with it), or
// a random one generated for this process when none is set.
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

test("the OpenCode server command carries the tools token, and Codex's exec environment never does", () => {
  assert.ok(commandFor("opencode", { PATH: "/bin" }).env.QA_TOOLS_TOKEN);
  assert.equal("QA_TOOLS_TOKEN" in codexExecEnv({ PATH: "/bin", QA_TOOLS_TOKEN: "secret", CODEX_API_KEY: "k" }), false);
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

test("the OpenCode server command always runs with a password in its environment", () => {
  const spec = commandFor("opencode", { PATH: "/bin" });
  assert.ok(spec.env.OPENCODE_SERVER_PASSWORD, "serve must never start without one");
  assert.equal(commandFor("codex", {}), undefined);
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

test("codexExecEnv forwards the DEV gate to a headless agent but never the test account", () => {
  const env = codexExecEnv({ PATH: "/bin", DEV_ENV_USER: "gate", DEV_ENV_PASS: "gate-pass", DEV_TEST_USER: "tester", DEV_TEST_PASS: "dev-pass", AGENT_RUNTIME_MODE: "single", GITHUB_TOKEN: "ghp_x" });
  assert.equal(env.DEV_ENV_USER, "gate");
  assert.equal(env.DEV_TEST_USER, undefined);
  assert.equal(env.DEV_TEST_PASS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
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

test("ensureCodexConfig forgets any project trust, so a repo's own .codex configuration is never loaded", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-trust-"));
  writeFileSync(
    join(codexHome, "config.toml"),
    '[auth]\nmethod = "chatgpt"\n\n[projects."/app/.mirrors/acme__shop"]\ntrust_level = "trusted"\n\n[mcp_servers.old]\ncommand = "x"\n',
    "utf8",
  );
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data" });
  const content = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.ok(!content.includes("trust_level"), "a trusted project would load its .codex/config.toml (MCP servers, hooks)");
  assert.ok(content.includes("[auth]"), "the rest of the file is preserved");
});

// ─── the authenticated browser is served by the orchestrator and is not an MCP server of the Codex config ───
// A Codex role cannot call a custom tool and must never be handed a browser that holds a session: the config the supervisor
// writes for every Codex role names no such server, and no tool of the authenticated browser.
test("ensureCodexConfig: the Codex config holds nothing of the authenticated browser", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-authbrowser-"));
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data" });
  const content = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.doesNotMatch(content, /authbrowser/i);
  assert.doesNotMatch(content, /QA_TOOLS/);
});

// ─── Codex OTel export: applied only when the operator names an endpoint ───

const OTLP = "http://collector-agents:4319";
const seed = (content) => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-otel-"));
  if (content !== undefined) writeFileSync(join(codexHome, "config.toml"), content, "utf8");
  return codexHome;
};
const configOf = (codexHome) => readFileSync(join(codexHome, "config.toml"), "utf8");

test("ensureCodexConfig: without QA_AGENT_OTLP_ENDPOINT the config holds nothing about telemetry, a blank value counts as unset, and an existing file is rewritten as it always was", () => {
  const plain = seed();
  ensureCodexConfig(plain, { ENGRAM_DATA_DIR: "/data" });
  assert.doesNotMatch(configOf(plain), /otel|trace_exporter/i);

  const blank = seed();
  ensureCodexConfig(blank, { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: "  " });
  assert.equal(configOf(blank), configOf(plain));

  const existing = seed('[auth]\napi_key = "sk-test-value"\n\n[otel]\nenvironment = "mine"\n');
  ensureCodexConfig(existing, { ENGRAM_DATA_DIR: "/data" });
  assert.match(configOf(existing), /\[otel\]\nenvironment = "mine"/, "an operator's own telemetry table is theirs");
});

test("ensureCodexConfig: with an endpoint, traces go to it over OTLP/HTTP, nothing goes anywhere else, and prompts are not logged", () => {
  const codexHome = seed();
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: OTLP });
  const toml = configOf(codexHome);
  assert.match(toml, /^\[otel\]$/m);
  assert.match(toml, /^log_user_prompt = false$/m);
  assert.match(toml, /^exporter = "none"$/m);
  assert.match(toml, /^metrics_exporter = "none"$/m);
  assert.match(toml, /^trace_exporter = \{ otlp-http = \{ endpoint = "http:\/\/collector-agents:4319\/v1\/traces", protocol = "binary" \} \}$/m);
  assert.ok(toml.includes("[mcp_servers.serena]"), "the MCP tables are still there");
});

test("ensureCodexConfig: the telemetry block is written once, survives a second boot byte for byte and keeps the rest of the file", () => {
  const codexHome = seed('[auth]\napi_key = "sk-test-value"\n');
  const env = { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: OTLP };
  ensureCodexConfig(codexHome, env);
  const first = configOf(codexHome);
  ensureCodexConfig(codexHome, env);
  assert.equal(configOf(codexHome), first);
  assert.equal(first.match(/^\[otel\]$/gm).length, 1);
  assert.ok(first.includes('api_key = "sk-test-value"'));
});

test("ensureCodexConfig: a boot without the endpoint takes the block it wrote earlier out again and leaves the rest as it was", () => {
  const codexHome = seed('[auth]\napi_key = "sk-test-value"\n');
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: OTLP });
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data" });
  const toml = configOf(codexHome);
  assert.doesNotMatch(toml, /otel|trace_exporter/i);
  assert.ok(toml.includes('api_key = "sk-test-value"') && toml.includes("[mcp_servers.engram]"));
});

test("ensureCodexConfig: an endpoint that is not a plain http(s) address is not written, whatever it tries to add to the file", () => {
  for (const endpoint of ["ftp://collector:4319", "collector-agents:4319", "http://user:pw@collector:4319", 'http://x"\n[projects."/"]\ntrust_level = "trusted"', "http://", "not a url"]) {
    const codexHome = seed();
    ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: endpoint });
    assert.doesNotMatch(configOf(codexHome), /otel|trace_exporter|trusted/i, endpoint);
  }
});

test("ensureCodexConfig: an operator's own [otel] table wins over the endpoint, which would otherwise define the table twice", () => {
  const codexHome = seed('[otel]\nenvironment = "mine"\n');
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: OTLP });
  const toml = configOf(codexHome);
  assert.equal(toml.match(/^\[otel\]$/gm).length, 1);
  assert.doesNotMatch(toml, /trace_exporter/);
});

test("ensureCodexConfig: an operator's telemetry configuration in any spelling wins over the endpoint", () => {
  for (const own of ["[ otel ]\nenvironment = \"mine\"\n", "[otel.exporter]\nx = 1\n", "[ otel . trace_exporter ]\nx = 1\n", "otel = { environment = \"mine\" }\n", "otel.environment = \"mine\"\n", "  otel . environment = \"mine\"\n", '"otel".environment = "mine"\n', "[[otel]]\n"]) {
    const codexHome = seed(own);
    ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: OTLP });
    assert.doesNotMatch(configOf(codexHome), /BEGIN qayaba-otel|v1\/traces/, own);
  }
});

test("ensureCodexConfig: a key that only starts with otel, or a table of another name, does not stop the endpoint", () => {
  const codexHome = seed('otelish = 1\n[oteldata]\nx = 1\n');
  ensureCodexConfig(codexHome, { ENGRAM_DATA_DIR: "/data", QA_AGENT_OTLP_ENDPOINT: OTLP });
  assert.match(configOf(codexHome), /v1\/traces/);
});
