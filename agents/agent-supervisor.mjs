#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The agent runtimes this supervisor runs. OpenCode is the only one today: it runs as a long-lived `opencode serve`.
// A second runtime is added as a member here plus the way it is started.
const PROVIDERS = ["opencode"];
const PORT = Number(process.env.AGENT_SUPERVISOR_PORT || 4097);
const RUNTIME_ENV_KEYS = new Set([
  "AGENT_PRIMARY_MODEL",
  "AGENT_REVIEWER_MODEL",
  "AGENT_CHAT_MODEL",
]);

// The OpenCode CLI can echo a key in an auth-failure message; never return
// it raw. Masks our configured key values verbatim plus common token shapes.
export function redactForResponse(msg) {
  if (typeof msg !== "string") return msg;
  let out = msg;
  for (const name of [...OPENCODE_PROVIDER_KEYS, "OPENCODE_SERVER_PASSWORD", "QA_TOOLS_TOKEN"]) {
    const value = process.env[name];
    if (value && value.length >= 6 && out.includes(value)) out = out.split(value).join("[REDACTED_CREDENTIAL]");
  }
  return out.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[REDACTED_CREDENTIAL]");
}

const children = new Map();
// The keys OpenCode can run on: its own gateway's, and every provider key agents/opencode.json reads ({env:NAME}).
export const OPENCODE_PROVIDER_KEYS = ["OPENCODE_API_KEY", "DEEPSEEK_API_KEY"];

const state = new Map(PROVIDERS.map((provider) => [provider, {
  provider,
  status: "stopped",
  configured: hasKey(provider),
}]));

function hasKey(provider) {
  return provider === "opencode" && OPENCODE_PROVIDER_KEYS.some((name) => Boolean(process.env[name]));
}

// The runtimes the supervisor keeps running: every one it knows.
function selectedProviders() {
  return PROVIDERS;
}

// `opencode serve` answers anyone who can reach port 4096 unless OPENCODE_SERVER_PASSWORD is set, and it
// only warns when it is not. The password compose gives both services is what the orchestrator
// authenticates with; with none set, a random one is generated for this process (kept across respawns)
// so the server is never open, and the orchestrator's calls fail loudly until the variable is aligned.
let generatedServerPassword;
export function openCodeServerEnv(env = process.env, { warn = console.warn } = {}) {
  const configured = env.OPENCODE_SERVER_PASSWORD?.trim();
  if (configured) return { ...env, OPENCODE_SERVER_PASSWORD: configured };
  if (!generatedServerPassword) {
    generatedServerPassword = randomBytes(32).toString("hex");
    warn("[supervisor] OPENCODE_SERVER_PASSWORD is not set: generated a random one for this boot. The orchestrator cannot authenticate with it; set the same OPENCODE_SERVER_PASSWORD on the orchestrator and agents services (see .env.example).");
  }
  return { ...env, OPENCODE_SERVER_PASSWORD: generatedServerPassword };
}

// The service token of the run_spec tool (agents/tool/run_spec.ts), which the orchestrator checks on its internal endpoint: the same
// value on both services (compose). Unset, a random one is generated for this process (kept across respawns), so the tool never
// runs with a token the orchestrator could mistake for its own; its calls are then refused, with a message that names the variable.
let generatedToolsToken;
export function qaToolsEnv(env = process.env, { warn = console.warn } = {}) {
  const configured = env.QA_TOOLS_TOKEN?.trim();
  if (configured) return { ...env, QA_TOOLS_TOKEN: configured };
  if (!generatedToolsToken) {
    generatedToolsToken = randomBytes(32).toString("hex");
    warn("[supervisor] QA_TOOLS_TOKEN is not set: generated a random one for this boot. The orchestrator will refuse the run_spec tool; set the same QA_TOOLS_TOKEN on the orchestrator and agents services (see .env.example).");
  }
  return { ...env, QA_TOOLS_TOKEN: generatedToolsToken };
}

// OpenCode merges the opencode.json and .opencode/ (agents, plugins, MCP servers, permission overrides) of a
// session's directory over its own configuration. A session directory is a watched repo's working copy, so
// the server ignores project configuration altogether. The baseline experiment (scripts/baseline-agent.ts)
// defines its agent in the copy's opencode.json and is the only reason to opt back in, with exactly
// AGENT_ALLOW_PROJECT_CONFIG=true on the agents service, for every role of that container.
function projectConfigEnv(env) {
  const { OPENCODE_DISABLE_PROJECT_CONFIG: _ignored, ...rest } = env;
  return env.AGENT_ALLOW_PROJECT_CONFIG === "true" ? rest : { ...rest, OPENCODE_DISABLE_PROJECT_CONFIG: "true" };
}

export function commandFor(provider, env = process.env) {
  // Only OpenCode is a managed long-lived process.
  if (provider === "opencode") {
    return {
      cmd: "opencode",
      args: ["serve", "--hostname", env.OPENCODE_SERVE_HOSTNAME || "0.0.0.0", "--port", "4096"],
      env: projectConfigEnv(qaToolsEnv(openCodeServerEnv(env))),
    };
  }
  return undefined;
}

function setState(provider, patch) {
  state.set(provider, { ...state.get(provider), provider, configured: hasKey(provider), ...patch });
}

function startProvider(provider) {
  if (children.has(provider)) return;
  if (!hasKey(provider)) {
    setState(provider, { status: "needs_config", error: undefined });
    return;
  }
  const spec = commandFor(provider);
  setState(provider, { status: "starting", error: undefined });
  const child = spawn(spec.cmd, spec.args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: spec.env,
  });
  children.set(provider, child);
  const readyTimer = setTimeout(() => {
    if (children.get(provider) === child) setState(provider, { status: "healthy" });
  }, 2500);

  child.on("exit", (code, signal) => {
    clearTimeout(readyTimer);
    if (children.get(provider) === child) children.delete(provider);
    const desired = selectedProviders().includes(provider);
    setState(provider, {
      status: desired && hasKey(provider) ? "failed" : "stopped",
      error: desired && hasKey(provider) ? `${provider} exited ${signal ?? code ?? "unknown"}` : undefined,
    });
    if (desired && hasKey(provider) && !shuttingDown) {
      setTimeout(() => startProvider(provider), 2000);
    }
  });
}

function stopProvider(provider) {
  const child = children.get(provider);
  if (!child) {
    setState(provider, { status: hasKey(provider) ? "stopped" : "needs_config", error: undefined });
    return Promise.resolve();
  }
  setState(provider, { status: "stopped", error: undefined });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      children.delete(provider);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function ensureDesired() {
  const desired = new Set(selectedProviders());
  for (const provider of PROVIDERS) {
    if (desired.has(provider)) startProvider(provider);
    else await stopProvider(provider);
  }
}

// One-shot at boot: wipe the OpenCode session DB so it never accumulates across the long-lived
// container (it grows run-after-run — ~49 MB observed — and a stale/locked row once produced a
// transient FK-constraint error). Auth is via OPENCODE_API_KEY (env), NOT the DB, so a wipe only
// drops resumable session history, which the orchestrator never relies on. MUST run BEFORE the first
// `opencode serve` spawn (an open DB cannot be cleanly replaced); it lives in the boot path only —
// never in startProvider (crash-restart, :128) or /restart, which would nuke a mid-life DB. The
// module-level flag makes it idempotent even if the boot path is ever reordered. Best-effort: a
// missing dir or a locked file degrades to a warning, never a crash.
let opencodeDbWiped = false;
function wipeOpencodeDbOnce() {
  if (opencodeDbWiped) return;
  opencodeDbWiped = true;
  const home = process.env.HOME || "/root";
  const dir = join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
  try {
    if (!existsSync(dir)) return;
    let wiped = 0;
    for (const name of readdirSync(dir)) {
      // opencode.db plus its SQLite sidecars (-wal, -shm, -journal).
      if (name === "opencode.db" || name.startsWith("opencode.db-")) {
        try { rmSync(join(dir, name), { force: true }); wiped++; } catch { /* best-effort per file */ }
      }
    }
    if (wiped > 0) console.log(`[agent-supervisor] wiped ${wiped} OpenCode session DB file(s) in ${dir} (auth is via OPENCODE_API_KEY, not the DB)`);
  } catch (err) {
    console.warn(`[agent-supervisor] could not wipe OpenCode session DB: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function applyRuntimeEnv(env) {
  if (!env || typeof env !== "object") return;
  for (const [key, value] of Object.entries(env)) {
    if (RUNTIME_ENV_KEYS.has(key) && typeof value === "string" && !/[\r\n]/.test(value)) {
      process.env[key] = value;
    }
  }
}

export async function restartProvider(provider, apiKey, runtimeEnv) {
  if (!PROVIDERS.includes(provider)) throw new Error("provider must be opencode");
  applyRuntimeEnv(runtimeEnv);
  if (apiKey) process.env.OPENCODE_API_KEY = apiKey;
  await stopProvider(provider);
  await ensureDesired();
  return state.get(provider);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body.trim() ? JSON.parse(body) : {};
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, providers: Object.fromEntries(state) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/providers") {
    json(res, 200, { providers: Object.fromEntries(state), desired: selectedProviders() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/restart") {
    try {
      const body = await readJson(req);
      const provider = String(body.provider || "");
      json(res, 200, { health: await restartProvider(provider, typeof body.apiKey === "string" ? body.apiKey : undefined, body.env) });
    } catch (err) {
      json(res, 400, { error: redactForResponse(err instanceof Error ? err.message : String(err)) });
    }
    return;
  }
  json(res, 404, { error: "not found" });
});

let shuttingDown = false;
async function shutdown() {
  shuttingDown = true;
  await Promise.all(PROVIDERS.map((provider) => stopProvider(provider)));
  server.close(() => process.exit(0));
}

// Bootstrap only when run as the entrypoint (`node agent-supervisor.mjs`), NOT when imported by a
// test. Importing the module must be side-effect-free so the exported pure helpers can be unit-tested
// without binding the port or registering signal handlers.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  // Clean the session DB ONCE, synchronously, before any `opencode serve` spawns (ensureDesired).
  wipeOpencodeDbOnce();
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[agent-supervisor] listening on :${PORT}`);
    void ensureDesired();
  });
}
