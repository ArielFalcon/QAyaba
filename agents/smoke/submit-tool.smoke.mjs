#!/usr/bin/env node
/**
 * submit tools transport smoke — IMAGE-GATED
 *
 * PURPOSE: proves, on the pinned OpenCode build inside the built `agents` image, that the custom tool agents/tool/submit.ts
 *   1. is loaded from the GLOBAL config directory with project configuration disabled (OPENCODE_DISABLE_PROJECT_CONFIG=true),
 *      and exports exactly the seven submit tools (submit_plan, submit_flow_review, submit_corrections, submit_result,
 *      submit_specs, submit_review, submit_profiles), their arguments built from agents/lib/submit-contracts.json,
 *   2. is switched on per role exactly as agents/opencode.json says (lead: plan, flow_review, corrections; author: result,
 *      specs; reviewer: review; proposer: profiles; assistant: none),
 *   3. is called by a real OpenCode session of qa-reviewer: OpenCode 1.17.7 does not validate a custom tool's arguments against its
 *      types (the schema is what the model is shown, not a gate), so every call the model makes reaches the orchestrator exactly as
 *      typed, a wrongly typed one included, and the orchestrator's contract is the only judge; the errors it returns reach the model
 *      as an ordinary tool result and the model calls again; each call carries the service token, the session id the runtime
 *      opened, the agent name it reports and the tool, and nothing the model typed outside the arguments,
 *   4. honours the per-prompt `tools` map exactly as platform/agent-runtime/opencode-client.ts builds it (F2/F7): the map becomes
 *      session permission rules that the last prompt to send any leaves in force, the last rule that matches a tool decides, and a
 *      pattern matches by name. A prompt armed with a submit tool is offered that one and none of the others; the continuation that may
 *      only submit (`{"*": false, <tool>: true}`) is offered that tool alone; a prompt that sends no map inherits the last one, and a
 *      prompt that sends the map of a prompt submitting nothing is offered the role's own tools again and no submit tool.
 * It uses a stub model and a stub orchestrator that live in this process, so it needs no API key and touches no DEV. OpenCode first
 * asks the model for a session title on the first message of a session; those requests offer no tools and are left out of the checks.
 *
 * Re-run it after every OpenCode pin bump or @opencode-ai/plugin bump: the plugin API and the prompt `tools` map are what the
 * tools depend on.
 *
 * WHY NOT IN `npm test`: it needs the `opencode` binary of the agents image and the package installed in /root/node_modules.
 *
 * HOW TO RUN (from the repo root; the image tag is whatever `docker compose build agents` produced):
 *   docker run --rm -v "$PWD/agents:/root/.config/opencode:ro" --entrypoint node qayaba-agents \
 *     /root/.config/opencode/smoke/submit-tool.smoke.mjs
 * To prove the image alone suffices (the repo ships no agents/node_modules), shadow the host's folder with an empty one:
 *   mkdir -p /tmp/empty && docker run ... -v /tmp/empty:/root/.config/opencode/node_modules:ro ...
 * Exit 0 only when every check passed.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const SOURCE = process.env.SUBMIT_SMOKE_CONFIG_SRC || "/root/.config/opencode";
// Under /root so that the tool's import of @opencode-ai/plugin resolves from /root/node_modules, as it does for the real config dir.
const HOME = "/root/.submit-smoke";
const SERVE_PORT = 4199;
const MODEL_PORT = 9107;
const ORCH_PORT = 9108;
const PASSWORD = "smoke-password";
const TOKEN = "smoke-token";
const EXPECTED_TOOLS = ["submit_plan", "submit_flow_review", "submit_corrections", "submit_result", "submit_specs", "submit_review", "submit_profiles"];
const EXPECTED_ALLOWED = {
  "qa-lead": ["submit_plan", "submit_flow_review", "submit_corrections"],
  "qa-author": ["submit_result", "submit_specs"],
  "qa-reviewer": ["submit_review"],
  "qa-proposer": ["submit_profiles"],
  "qa-assistant": [],
};

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

const orchestratorCalls = [];
const modelRequests = [];
// What the stub model does on a request: by the number of tool results it has already been given in the session.
let script = [];

function startStubs() {
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      const toolResults = (j.messages || []).filter((m) => m.role === "tool");
      const title = JSON.stringify(j.messages || []).includes("Generate a title for this conversation");
      modelRequests.push({ title, tools: (j.tools || []).map((t) => t.function?.name), toolResults: toolResults.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
      const step = script[toolResults.length];
      if (step) {
        res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${toolResults.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }));
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
      const parsed = JSON.parse(body || "{}");
      orchestratorCalls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: parsed });
      res.writeHead(200, { "content-type": "application/json" });
      const refusal = typeof parsed.answer?.approved !== "boolean"
        ? { path: "approved", reason: "SMOKE-TYPE-REFUSAL approved must be true or false" }
        : Array.isArray(parsed.answer.corrections) && parsed.answer.corrections.length > 0
          ? { path: "corrections.0.citation", reason: "SMOKE-REFUSAL a blocking correction needs a citation" }
          : undefined;
      res.end(JSON.stringify(refusal
        ? { ok: false, code: "invalid-answer", message: "submit_review was not accepted: fix every error and call it again with the whole answer", errors: [refusal] }
        : { ok: true, message: "accepted: submit_review is your answer; end the turn" }));
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
  config.agent["qa-reviewer"].model = "stub/stub-model";
  config.agent["qa-reviewer"].prompt = "You are a smoke test.";
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

// One prompt, in a new session or in `session`; the requests that answer it are those that are not the session's title request.
async function prompt(tools, session) {
  const opened = session ?? (await api("/session?directory=/tmp/submit-smoke-repo", { method: "POST", body: "{}" }));
  const before = modelRequests.length;
  const answer = await api(`/session/${opened.id}/message?directory=/tmp/submit-smoke-repo`, {
    method: "POST",
    body: JSON.stringify({ agent: "qa-reviewer", parts: [{ type: "text", text: "go" }], ...(tools ? { tools } : {}) }),
  });
  return { session: opened, answer, requests: modelRequests.slice(before).filter((request) => !request.title) };
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
  mkdirSync("/tmp/submit-smoke-repo", { recursive: true });

  const ids = await api("/experimental/tool/ids");
  check(EXPECTED_TOOLS.every((id) => ids.includes(id)), "the seven submit tools are tools of the server, loaded from the global config directory with project configuration disabled");
  check(!ids.some((id) => id.startsWith("submit_") && !EXPECTED_TOOLS.includes(id)), `the file exports no other submit tool (found: ${JSON.stringify(ids.filter((id) => id.startsWith("submit_")))})`);

  const agents = await api("/agent");
  for (const [name, expected] of Object.entries(EXPECTED_ALLOWED)) {
    const agent = agents.find((a) => a.name === name);
    const allowed = EXPECTED_TOOLS.filter((tool) => agent?.permission.filter((r) => r.permission === tool).at(-1)?.action === "allow");
    check(JSON.stringify(allowed) === JSON.stringify(EXPECTED_TOOLS.filter((tool) => expected.includes(tool))), `${name} may call exactly ${JSON.stringify(expected)} (allowed: ${JSON.stringify(allowed)})`);
  }

  // A call whose arguments have the wrong types, then one the orchestrator refuses for its content, then one it accepts.
  const typed = [
    { approved: "yes", corrections: "none" },
    { approved: false, corrections: [{ text: "[false-positive] a.spec.ts: asserts nothing", severity: "blocking" }] },
    { approved: true, corrections: [] },
  ];
  script = typed.map((args) => ({ tool: "submit_review", args }));
  const run = await prompt();
  const reached = orchestratorCalls.filter((c) => c.body.tool === "submit_review");
  const call = reached[0];
  check(reached.length === typed.length, `every call the model made reached the orchestrator, the wrongly typed one included: the runtime does not validate a custom tool's arguments (calls: ${reached.length})`);
  check(JSON.stringify(reached.map((c) => c.body.answer)) === JSON.stringify(typed), "the answer of each call is the arguments the model typed, as typed");
  check(call?.method === "POST" && call.url === "/internal/submit", "a call is POST /internal/submit");
  check(call?.authorization === `Bearer ${TOKEN}`, "a call carries the service token");
  check(call?.body.sessionID === run.session.id, "a call names the session the runtime opened (ToolContext.sessionID)");
  check(call?.body.agent === "qa-reviewer", "a call names the agent the runtime reports (ToolContext.agent)");
  check(typeof call?.body.messageID === "string" && call.body.messageID.startsWith("msg_"), "a call names the assistant message the runtime reports (ToolContext.messageID)");
  check(JSON.stringify(Object.keys(call?.body ?? {}).sort()) === JSON.stringify(["agent", "answer", "messageID", "sessionID", "tool"]), "a call carries the session, the agent, the message, the tool and the answer, and nothing else");
  check(run.requests[1]?.toolResults.some((text) => text.includes("SMOKE-TYPE-REFUSAL") && text.includes("approved")), "the orchestrator's refusal of the wrongly typed call reached the model as an ordinary tool result, with the path and the reason");
  const lastRequest = run.requests.at(-1);
  check(lastRequest?.toolResults.some((text) => text.includes("SMOKE-REFUSAL") && text.includes("corrections.0.citation")), "the orchestrator's errors for the content reached the model as an ordinary tool result, with the path and the reason");
  check(lastRequest?.toolResults.length === typed.length, "the model was given a result for every call it made");
  check(run.answer.parts?.some((p) => p.type === "text" && p.text === "done"), "the turn ended on the model's final text");

  // F2/F7: the map of a prompt armed with submit_review denies the other submit tools by name.
  script = [];
  const others = EXPECTED_TOOLS.filter((tool) => tool !== "submit_review");
  const armed = await prompt(Object.fromEntries(others.map((tool) => [tool, false])));
  const offered = armed.requests[0]?.tools ?? [];
  check(offered.includes("submit_review") && !others.some((tool) => offered.includes(tool)), `an armed prompt is offered its own submit tool and no other (offered: ${JSON.stringify(offered)})`);

  // The map of the continuation that may only submit: every tool denied, whatever its name, then the armed tool allowed.
  const only = await prompt({ "*": false, submit_review: true }, armed.session);
  const offeredOnly = only.requests[0]?.tools ?? [];
  check(JSON.stringify(offeredOnly) === JSON.stringify(["submit_review"]), `a continuation that may only submit is offered the submit tool alone (offered: ${JSON.stringify(offeredOnly)})`);

  // The session keeps the rules of the last prompt that sent a map; one that sends none inherits them, one that sends a map replaces them.
  const inherited = await prompt(undefined, only.session);
  check(JSON.stringify(inherited.requests[0]?.tools) === JSON.stringify(["submit_review"]), `a prompt that sends no map inherits the restriction of the continuation before it (offered: ${JSON.stringify(inherited.requests[0]?.tools)})`);
  const restored = await prompt({ "submit_*": false }, only.session);
  const offeredRestored = restored.requests[0]?.tools ?? [];
  check(offeredRestored.includes("read") && offeredRestored.includes("glob") && !offeredRestored.some((name) => name.startsWith("submit_")), `a prompt that submits nothing sends submit_* denied: the role's own tools come back and no submit tool (offered: ${JSON.stringify(offeredRestored)})`);
} catch (err) {
  check(false, `the smoke could not complete: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.kill("SIGKILL");
  stopStubs();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nsubmit tools smoke: OK" : `\nsubmit tools smoke: ${failures.length} check(s) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
