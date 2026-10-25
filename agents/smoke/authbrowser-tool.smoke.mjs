#!/usr/bin/env node
/**
 * Authenticated browser tools transport smoke — IMAGE-GATED
 *
 * PURPOSE: proves, on the pinned OpenCode build inside the built `agents` image, that the custom tools in agents/tool/authbrowser.ts
 *   1. are loaded from the GLOBAL config directory with project configuration disabled (OPENCODE_DISABLE_PROJECT_CONFIG=true), under
 *      the names authbrowser_navigate / authbrowser_snapshot / authbrowser_click / authbrowser_type,
 *   2. are switched on for the authoring roles (qa-generator, qa-sidekick) alone and off for every other agent (agents/opencode.json),
 *      and a role that is not an authoring one is not even OFFERED them in the model's tool list,
 *   3. are called by real OpenCode sessions of qa-generator and qa-sidekick, and each call reaches the orchestrator's endpoint with the
 *      service token, the session id the runtime opened and the agent name it reports (ToolContext), and its answer goes back to the model.
 * It uses a stub model and a stub orchestrator that live in this process, so it needs no API key and touches no DEV.
 *
 * Re-run it after every OpenCode pin bump or @opencode-ai/plugin bump: the plugin API and the naming of a file's exports are the things
 * the tools depend on.
 *
 * WHY NOT IN `npm test`: it needs the `opencode` binary of the agents image and the package installed in /root/node_modules.
 *
 * HOW TO RUN (from the repo root; the image tag is whatever `docker compose build agents` produced):
 *   docker run --rm -v "$PWD/agents:/root/.config/opencode:ro" --entrypoint node ai-pipeline-agents \
 *     /root/.config/opencode/smoke/authbrowser-tool.smoke.mjs
 * Exit 0 only when every check passed.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const SOURCE = process.env.AUTHBROWSER_SMOKE_CONFIG_SRC || "/root/.config/opencode";
// Under /root so that the tool's import of @opencode-ai/plugin resolves from /root/node_modules, as it does for the real config dir.
const HOME = "/root/.authbrowser-smoke";
const SERVE_PORT = 4197;
const MODEL_PORT = 9103;
const ORCH_PORT = 9104;
const PASSWORD = "smoke-password";
const TOKEN = "smoke-token";

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

const orchestratorCalls = [];
const modelRequests = [];

const TOOLS = ["authbrowser_navigate", "authbrowser_snapshot", "authbrowser_click", "authbrowser_type"];
// What each stubbed agent asks for on its first turn; an agent with no entry answers in text and calls nothing.
const FIRST_CALL = {
  "qa-generator": { name: "authbrowser_navigate", arguments: { url: "/orders?page=2" } },
  "qa-sidekick": { name: "authbrowser_type", arguments: { ref: "e7", text: "hello", submit: true } },
};
const agentOf = (messages) => /AGENT:([a-z-]+)/.exec(JSON.stringify(messages ?? []))?.[1];

function startStubs() {
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      const agent = agentOf(j.messages);
      modelRequests.push({ agent, tools: (j.tools || []).map((t) => t.function?.name), roles: (j.messages || []).map((m) => m.role) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
      const wanted = FIRST_CALL[agent];
      if (wanted && !(j.messages || []).some((m) => m.role === "tool")) {
        res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: wanted.name, arguments: JSON.stringify(wanted.arguments) } }] }));
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
      res.end(JSON.stringify({ ok: true, page: { url: "https://dev/orders", title: "Orders", snapshot: "- heading [ref=e1]" }, blocked: [], notes: [], budget: { callsLeft: 149 } }));
    });
  });
  model.listen(MODEL_PORT, "127.0.0.1");
  orchestrator.listen(ORCH_PORT, "127.0.0.1");
  return () => { model.close(); orchestrator.close(); };
}

const STUBBED = ["qa-generator", "qa-sidekick", "qa-reviewer"];

function prepareConfig() {
  rmSync(HOME, { recursive: true, force: true });
  const dir = join(HOME, "opencode");
  mkdirSync(dir, { recursive: true });
  cpSync(SOURCE, dir, { recursive: true, filter: (src) => !src.includes("/node_modules") && !src.includes("/smoke") && !/\/agent(\/|$)/.test(src) });
  const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  config.provider = { stub: { npm: "@ai-sdk/openai-compatible", name: "stub", options: { baseURL: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: "x" }, models: { "stub-model": { name: "stub-model", tool_call: true, limit: { context: 100000, output: 4000 } } } } };
  // The prompt files are not copied (an agent/ directory would define the agents over this config); every agent gets a marker prompt.
  for (const name of Object.keys(config.agent)) config.agent[name].prompt = `AGENT:${name} You are a smoke test.`;
  for (const name of STUBBED) config.agent[name].model = "stub/stub-model";
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
  const ids = await api("/experimental/tool/ids");
  check(TOOLS.every((t) => ids.includes(t)), `the four tools are tools of the server, loaded from the global config directory with project configuration disabled, under the names ${TOOLS.join(", ")}`);

  const agents = await api("/agent");
  const allowedBy = (tool) => agents.filter((a) => a.permission.filter((r) => r.permission === tool).at(-1)?.action === "allow").map((a) => a.name).sort();
  for (const tool of TOOLS) {
    check(JSON.stringify(allowedBy(tool)) === JSON.stringify(["qa-generator", "qa-sidekick"]), `only qa-generator and qa-sidekick may call ${tool} (allowed: ${JSON.stringify(allowedBy(tool))})`);
  }

  mkdirSync("/tmp/authbrowser-smoke-repo", { recursive: true });
  const turn = async (agent) => {
    const session = await api("/session?directory=/tmp/authbrowser-smoke-repo", { method: "POST", body: "{}" });
    const answer = await api(`/session/${session.id}/message?directory=/tmp/authbrowser-smoke-repo`, { method: "POST", body: JSON.stringify({ agent, parts: [{ type: "text", text: "go" }] }) });
    return { session, answer };
  };

  const generator = await turn("qa-generator");
  const sidekick = await turn("qa-sidekick");
  const reviewer = await turn("qa-reviewer");

  check(orchestratorCalls.length === 2, `the two authoring sessions made one call each to the orchestrator and no other session made any (saw ${orchestratorCalls.length})`);
  const fromGenerator = orchestratorCalls.find((c) => c.body.sessionID === generator.session.id);
  check(fromGenerator?.method === "POST" && fromGenerator.url === "/internal/authbrowser", "the generator's call is POST /internal/authbrowser");
  check(fromGenerator?.authorization === `Bearer ${TOKEN}`, "the call carries the service token");
  check(fromGenerator?.body.agent === "qa-generator", "the call names the agent the runtime reports (ToolContext.agent)");
  check(typeof fromGenerator?.body.messageID === "string" && fromGenerator.body.messageID.startsWith("msg_"), "the call names the assistant message the runtime reports (ToolContext.messageID), which joins it to the trace");
  check(fromGenerator?.body.action === "navigate" && fromGenerator?.body.url === "/orders?page=2", "the call carries the action and the model's arguments");
  const fromSidekick = orchestratorCalls.find((c) => c.body.sessionID === sidekick.session.id);
  check(fromSidekick?.body.agent === "qa-sidekick" && fromSidekick?.body.action === "type" && fromSidekick?.body.ref === "e7" && fromSidekick?.body.text === "hello" && fromSidekick?.body.submit === true, "the sidekick's call names its own agent and carries ref, text and submit");

  const offered = (agent) => modelRequests.filter((r) => r.agent === agent).flatMap((r) => r.tools);
  check(TOOLS.every((t) => offered("qa-generator").includes(t)) && TOOLS.every((t) => offered("qa-sidekick").includes(t)), "all four tools were offered to the generator and to the sidekick");
  check(!offered("qa-reviewer").some((t) => t.startsWith("authbrowser")), "no authbrowser tool was offered to a reviewer");
  check(modelRequests.filter((r) => r.agent === "qa-generator").at(-1)?.roles.includes("tool"), "the orchestrator's answer went back to the model as a tool result");
  check(generator.answer.parts?.some((p) => p.type === "text" && p.text === "done"), "the turn ended on the model's final text");
  check(reviewer.answer.parts?.some((p) => p.type === "text" && p.text === "done"), "the roles that are not offered the tools still answer normally");

  // A per-prompt tools map can hide the tools from a session that is allowed them (what the transport does for a prompt that asks for no tool at all).
  const before = modelRequests.length;
  const hidden = await api("/session?directory=/tmp/authbrowser-smoke-repo", { method: "POST", body: "{}" });
  await api(`/session/${hidden.id}/message?directory=/tmp/authbrowser-smoke-repo`, { method: "POST", body: JSON.stringify({ agent: "qa-generator", tools: { "authbrowser*": false }, parts: [{ type: "text", text: "go" }] }) });
  const hiddenTurn = modelRequests.slice(before).filter((r) => r.agent === "qa-generator");
  check(hiddenTurn.length > 0 && hiddenTurn.every((r) => !r.tools.some((t) => t.startsWith("authbrowser"))), "a per-prompt tools map with \"authbrowser*\": false hides the tools from an allowed role");
  check(hiddenTurn.length > 0 && hiddenTurn.every((r) => r.tools.includes("read") && r.tools.includes("write") && r.tools.includes("run_spec")), "and leaves every other tool of the role as its configuration has it");
} catch (err) {
  check(false, `the smoke could not complete: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.kill("SIGKILL");
  stopStubs();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nauthenticated browser tools smoke: OK" : `\nauthenticated browser tools smoke: ${failures.length} check(s) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
