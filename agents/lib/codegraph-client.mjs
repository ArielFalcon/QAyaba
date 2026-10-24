// The lead's side of the code-graph tools (`codegraph_*`): one authenticated POST to the orchestrator's internal tools endpoint per
// tool call, and the answer shaped for a model to read. Plain JavaScript with the environment and `fetch` injected, so it is tested
// without OpenCode (agents/lib/codegraph-client.test.mjs); tool/codegraph.ts is only the OpenCode wrapper around it.
//
// The orchestrator holds the graph, binds every query to the run's own project and decides everything: whether the session may
// call, how many calls are left, what an answer may say. This file carries the session and agent the runtime reports, the action
// and the arguments the model chose, and the service token. It never carries the token into what it returns, and it forwards only
// the arguments each action declares: never a project.

import { endpointOf, messageIdOf } from "./run-spec-client.mjs";

export const TOKEN_ENV = "QA_TOOLS_TOKEN";
export const CODEGRAPH_PATH = "/internal/codegraph";
// Longer than the orchestrator's cap on one query, so its answer, its refusal included, is what the model reads.
export const CLIENT_TIMEOUT_MS = 45 * 1000;

// What each action may carry. Anything else the model sends is dropped here and refused again by the orchestrator.
const ARGUMENTS = {
  search_graph: ["name_pattern", "query", "label", "limit"],
  trace_path: ["function_name", "direction", "depth"],
  get_code_snippet: ["qualified_name"],
};

function asText(body) {
  return JSON.stringify(body);
}

export async function callCodeGraph({ action, args, context, env, fetchFn = fetch, timeoutMs = CLIENT_TIMEOUT_MS }) {
  const token = (env[TOKEN_ENV] ?? "").trim();
  if (token === "") {
    return asText({ ok: false, code: "not-configured", message: `the code graph is not configured in this runtime (${TOKEN_ENV} is not set)` });
  }
  const declared = {};
  for (const name of ARGUMENTS[action] ?? []) if (args[name] !== undefined) declared[name] = args[name];
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (context.abort) signals.push(context.abort);
  let response;
  try {
    response = await fetchFn(endpointOf(env, CODEGRAPH_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionID: context.sessionID, agent: context.agent, ...messageIdOf(context), action, ...declared }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    // Nothing of the failure is quoted: a transport error can carry the address and headers.
    const reason = err && err.name === "TimeoutError" ? "timed out waiting for the orchestrator" : "could not reach the orchestrator";
    return asText({ ok: false, code: "unreachable", message: `the code graph ${reason}` });
  }
  const raw = await response.text().catch(() => "");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return asText({ ok: false, code: "bad-response", message: `the code graph got an answer it could not read (HTTP ${response.status})` });
  }
  return asText(body);
}
