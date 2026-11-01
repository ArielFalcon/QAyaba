// The agent's side of the submit tools: one authenticated POST to the orchestrator's internal tools endpoint per tool call, and the
// answer shaped for a model to read. Plain JavaScript with the environment and `fetch` injected, so it is tested without OpenCode
// (agents/lib/submit-client.test.mjs); tool/submit.ts is only the OpenCode wrapper around it.
//
// The orchestrator judges the answer: it holds the contract of the turn this session is in and returns the errors (a path and a
// reason each) the model corrects inside the same turn. This file carries the session and agent the runtime reports, the tool and
// the arguments the model typed, and the service token. It writes and runs nothing, and never carries the token into what it returns.

import { endpointOf, messageIdOf, TOKEN_ENV } from "./run-spec-client.mjs";

export const SUBMIT_PATH = "/internal/submit";
// Longer than the orchestrator's check of an answer, so its verdict, a refusal included, is what the model reads.
export const CLIENT_TIMEOUT_MS = 30 * 1000;

function asText(body) {
  return JSON.stringify(body);
}

export async function callSubmit({ tool, answer, context, env, fetchFn = fetch, timeoutMs = CLIENT_TIMEOUT_MS }) {
  const token = (env[TOKEN_ENV] ?? "").trim();
  if (token === "") {
    return asText({ ok: false, code: "not-configured", message: `${tool} is not configured in this runtime (${TOKEN_ENV} is not set)` });
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (context.abort) signals.push(context.abort);
  let response;
  try {
    response = await fetchFn(endpointOf(env, SUBMIT_PATH), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionID: context.sessionID, agent: context.agent, ...messageIdOf(context), tool, answer }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    // Nothing of the failure is quoted: a transport error can carry the address and headers.
    const reason = err && err.name === "TimeoutError" ? "timed out waiting for the orchestrator" : "could not reach the orchestrator";
    return asText({ ok: false, code: "unreachable", message: `${tool} ${reason}; call it again with the same answer` });
  }
  const raw = await response.text().catch(() => "");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return asText({ ok: false, code: "bad-response", message: `${tool} got an answer it could not read (HTTP ${response.status}); call it again with the same answer` });
  }
  return asText(body);
}
