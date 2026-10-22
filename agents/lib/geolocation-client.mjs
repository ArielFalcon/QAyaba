// The authoring agents' side of the location (`set_geolocation`): one authenticated POST to the orchestrator's internal tools
// endpoint per call, and the answer shaped for a model to read. Plain JavaScript with the environment and `fetch` injected, so
// it is tested without OpenCode (agents/lib/geolocation-client.test.mjs); tool/set_geolocation.ts is only the OpenCode wrapper.
//
// The orchestrator holds the location and decides everything: which scope the session may move, which places exist and what a
// valid point is. This file carries the session and agent the runtime reports, the place or the point the model chose, and the
// service token. It never carries the token into what it returns.

import { endpointOf, messageIdOf } from "./run-spec-client.mjs";

export const TOKEN_ENV = "QA_TOOLS_TOKEN";
export const GEOLOCATION_PATH = "/internal/geolocation";
// A location change opens no page and waits for no account: the orchestrator answers immediately. The bound is still generous
// enough for a slow network, and the orchestrator's refusal is what the model reads, never a client timeout.
export const CLIENT_TIMEOUT_MS = 15 * 1000;

const ARGUMENTS = ["place", "latitude", "longitude"];

function asText(body) {
  return JSON.stringify(body);
}

export async function callGeolocation({ args, context, env, fetchFn = fetch, timeoutMs = CLIENT_TIMEOUT_MS }) {
  const token = (env[TOKEN_ENV] ?? "").trim();
  if (token === "") {
    return asText({ ok: false, code: "not-configured", message: `the authoring location is not configured in this runtime (${TOKEN_ENV} is not set)` });
  }
  const declared = {};
  for (const name of ARGUMENTS) if (args[name] !== undefined) declared[name] = args[name];
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (context.abort) signals.push(context.abort);
  let response;
  try {
    response = await fetchFn(endpointOf(env, GEOLOCATION_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionID: context.sessionID, agent: context.agent, ...messageIdOf(context), ...declared }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    const reason = err && err.name === "TimeoutError" ? "timed out waiting for the orchestrator" : "could not reach the orchestrator";
    return asText({ ok: false, code: "unreachable", message: `the authoring location ${reason}` });
  }
  const raw = await response.text().catch(() => "");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return asText({ ok: false, code: "bad-response", message: `the authoring location got an answer it could not read (HTTP ${response.status})` });
  }
  return asText(body);
}
