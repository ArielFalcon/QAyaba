// The authoring agents' side of the authenticated browser (`authbrowser_*`): one authenticated POST to the orchestrator's internal
// tools endpoint per tool call, and the answer shaped for a model to read. Plain JavaScript with the environment and `fetch`
// injected, so it is tested without OpenCode (agents/lib/authbrowser-client.test.mjs); tool/authbrowser.ts is only the OpenCode
// wrapper around it.
//
// The orchestrator holds the browser and the saved session, and decides everything: whether the session may call, how many calls
// are left, what the browser may request. This file carries the session and agent the runtime reports, the action and the
// arguments the model chose, and the service token. It never carries the token into what it returns, and it forwards only the
// arguments each action declares.

import { endpointOf, messageIdOf } from "./run-spec-client.mjs";

export const TOKEN_ENV = "QA_TOOLS_TOKEN";
export const AUTHBROWSER_PATH = "/internal/authbrowser";
// Longer than any call the orchestrator allows (its per-call cap plus its wait for the test account), so the orchestrator's answer,
// its refusal included, is what the model reads, not a timeout of this client.
export const CLIENT_TIMEOUT_MS = 90 * 1000;

// What each action may carry. Anything else the model sends is dropped here and refused again by the orchestrator.
const ARGUMENTS = {
  navigate: ["url"],
  snapshot: [],
  click: ["ref"],
  type: ["ref", "text", "submit"],
};

function asText(body) {
  return JSON.stringify(body);
}

export async function callAuthBrowser({ action, args, context, env, fetchFn = fetch, timeoutMs = CLIENT_TIMEOUT_MS }) {
  const token = (env[TOKEN_ENV] ?? "").trim();
  if (token === "") {
    return asText({ ok: false, code: "not-configured", message: `the authenticated browser is not configured in this runtime (${TOKEN_ENV} is not set)` });
  }
  const declared = {};
  for (const name of ARGUMENTS[action] ?? []) if (args[name] !== undefined) declared[name] = args[name];
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (context.abort) signals.push(context.abort);
  let response;
  try {
    response = await fetchFn(endpointOf(env, AUTHBROWSER_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionID: context.sessionID, agent: context.agent, ...messageIdOf(context), action, ...declared }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    // Nothing of the failure is quoted: a transport error can carry the address and headers.
    const reason = err && err.name === "TimeoutError" ? "timed out waiting for the orchestrator" : "could not reach the orchestrator";
    return asText({ ok: false, code: "unreachable", message: `the authenticated browser ${reason}` });
  }
  const raw = await response.text().catch(() => "");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return asText({ ok: false, code: "bad-response", message: `the authenticated browser got an answer it could not read (HTTP ${response.status})` });
  }
  return asText(body);
}
