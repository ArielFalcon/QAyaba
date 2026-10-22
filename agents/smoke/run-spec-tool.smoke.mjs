#!/usr/bin/env node
/**
 * run_spec tool transport smoke — IMAGE-GATED
 *
 * PURPOSE: proves, on the pinned OpenCode build inside the built `agents` image, that the custom tool agents/tool/run_spec.ts
 *   1. is loaded from the GLOBAL config directory with project configuration disabled (OPENCODE_DISABLE_PROJECT_CONFIG=true),
 *   2. is switched off for every agent but the authoring roles, qa-generator and qa-sidekick (agents/opencode.json),
 *   3. is called by a real OpenCode session of qa-generator, and the call reaches the orchestrator's endpoint with the service
 *      token, the session id the runtime opened and the agent name it reports (ToolContext), and its answer goes back to the model.
 * It uses a stub model and a stub orchestrator that live in this process, so it needs no API key and touches no DEV.
 *
 * Re-run it after every OpenCode pin bump or @opencode-ai/plugin bump: the plugin API is the one thing the tool depends on.
 *
 * WHY NOT IN `npm test`: it needs the `opencode` binary of the agents image and the package installed in /root/node_modules.
 *
 * HOW TO RUN (from the repo root; the image tag is whatever `docker compose build agents` produced):
 *   docker run --rm -v "$PWD/agents:/root/.config/opencode:ro" --entrypoint node ai-pipeline-agents \
 *     /root/.config/opencode/smoke/run-spec-tool.smoke.mjs
 * To prove the image alone suffices (the repo ships no agents/node_modules), shadow the host's folder with an empty one:
 *   mkdir -p /tmp/empty && docker run ... -v /tmp/empty:/root/.config/opencode/node_modules:ro ...
 * Exit 0 only when every check passed.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const SOURCE = process.env.RUN_SPEC_SMOKE_CONFIG_SRC || "/root/.config/opencode";
// Under /root so that the tool's import of @opencode-ai/plugin resolves from /root/node_modules, as it does for the real config dir.
const HOME = "/root/.run-spec-smoke";
const SERVE_PORT = 4196;
const MODEL_PORT = 9101;
const ORCH_PORT = 9102;
const PASSWORD = "smoke-password";
const TOKEN = "smoke-token";

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

const orchestratorCalls = [];
const modelRequests = [];

function startStubs() {
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      modelRequests.push({ tools: (j.tools || []).map((t) => t.function?.name), roles: (j.messages || []).map((m) => m.role) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
      if (!(j.messages || []).some((m) => m.role === "tool")) {
        res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run_spec", arguments: JSON.stringify({ path: "e2e/flows/a.spec.ts", grep: "adds (one)" }) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: "done" }));
        res.write(chunk({}, "stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const orchestrator = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      orchestratorCalls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, report: { status: "passed", tests: [], budget: { callsLeft: 7 } } }));
    });
  });
  model.listen(MODEL_PORT, "127.0.0.1");
  orchestrator.listen(ORCH_PORT, "127.0.0.1");
  return () => { model.close(); orchestrator.close(); };
}

function prepareConfig() {
  rmSync(HOME, { recursive: true, force: true });
  const dir = join(HOME, "opencode");
  mkdirSync(dir, { recursive: true });
  cpSync(SOURCE, dir, { recursive: true, filter: (src) => !src.includes("/node_modules") && !src.includes("/smoke") });
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  config.provider = { stub: { npm: "@ai-sdk/openai-compatible", name: "stub", options: { baseURL: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: "x" }, models: { "stub-model": { name: "stub-model", tool_call: true, limit: { context: 100000, output: 4000 } } } } };
  config.agent["qa-generator"].model = "stub/stub-model";
  config.agent["qa-generator"].prompt = "You are a smoke test.";
  config.mcp = {};
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2));
}

const api = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${SERVE_PORT}${path}`, { ...init, headers: { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`, "content-type": "application/json", ...(init.headers || {}) } });
  return res.json();
};

async function waitUntilServing() {
  for (let i = 0; i < 60; i++) {
    try {
      await api("/experimental/tool/ids");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("opencode serve did not come up");
}

const stopStubs = startStubs();
prepareConfig();
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(SERVE_PORT)], {
  cwd: "/tmp",
  env: { ...process.env, XDG_CONFIG_HOME: HOME, OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_DISABLE_PROJECT_CONFIG: "true", QA_TOOLS_TOKEN: TOKEN, QA_TOOLS_URL: `http://127.0.0.1:${ORCH_PORT}` },
  stdio: "ignore",
});

try {
  await waitUntilServing();
  check((await api("/experimental/tool/ids")).includes("run_spec"), "run_spec is a tool of the server, loaded from the global config directory with project configuration disabled");

  const agents = await api("/agent");
  const allowed = agents.filter((a) => a.permission.filter((r) => r.permission === "run_spec").at(-1)?.action === "allow").map((a) => a.name);
  check(JSON.stringify([...allowed].sort()) === JSON.stringify(["qa-generator", "qa-sidekick"]), `only the authoring roles (qa-generator, qa-sidekick) may call run_spec (allowed: ${JSON.stringify(allowed)})`);

  mkdirSync("/tmp/run-spec-smoke-repo", { recursive: true });
  const session = await api("/session?directory=/tmp/run-spec-smoke-repo", { method: "POST", body: "{}" });
  const answer = await api(`/session/${session.id}/message?directory=/tmp/run-spec-smoke-repo`, { method: "POST", body: JSON.stringify({ agent: "qa-generator", parts: [{ type: "text", text: "go" }] }) });
  const call = orchestratorCalls[0];
  check(orchestratorCalls.length === 1, "the generator's session made exactly one call to the orchestrator");
  check(call?.method === "POST" && call.url === "/internal/run-spec", "the call is POST /internal/run-spec");
  check(call?.authorization === `Bearer ${TOKEN}`, "the call carries the service token");
  check(call?.body.sessionID === session.id, "the call names the session the runtime opened (ToolContext.sessionID)");
  check(call?.body.agent === "qa-generator", "the call names the agent the runtime reports (ToolContext.agent)");
  check(typeof call?.body.messageID === "string" && call.body.messageID.startsWith("msg_"), "the call names the assistant message the runtime reports (ToolContext.messageID), which joins it to the trace");
  check(call?.body.path === "e2e/flows/a.spec.ts" && call?.body.grep === "adds (one)", "the call carries the model's path and grep");
  check(modelRequests.at(-1)?.roles.includes("tool"), "the orchestrator's answer went back to the model as a tool result");
  check(answer.parts?.some((p) => p.type === "text" && p.text === "done"), "the turn ended on the model's final text");
  check(modelRequests.some((r) => r.tools.includes("run_spec")), "run_spec was among the tools offered to the generator");
} catch (err) {
  check(false, `the smoke could not complete: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.kill("SIGKILL");
  stopStubs();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nrun_spec tool smoke: OK" : `\nrun_spec tool smoke: ${failures.length} check(s) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
