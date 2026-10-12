// The generator's side of `run_spec`: one authenticated POST to the orchestrator's internal tools endpoint, and the answer
// shaped for a model to read. Plain JavaScript with the environment and `fetch` injected, so it is tested without OpenCode
// (agents/lib/run-spec-client.test.mjs); tool/run_spec.ts is only the OpenCode wrapper around it.
//
// The orchestrator decides everything: whether the session may call, how many calls are left, how long one may run. This
// file carries the session and agent the runtime reports, the path and the filter the model chose, and the service token. It
// never carries the token into what it returns.

export const TOKEN_ENV = "QA_TOOLS_TOKEN";
export const PORT_ENV = "QA_TOOLS_PORT";
export const URL_ENV = "QA_TOOLS_URL";
export const DEFAULT_PORT = "459";
export const DEFAULT_HOST = "orchestrator";
// Longer than any call the orchestrator allows (its per-call cap tops out at ten minutes), so the orchestrator's answer, its
// refusal included, is what the model reads, not a timeout of this client.
export const CLIENT_TIMEOUT_MS = 12 * 60 * 1000;

export function endpointOf(env, path = "/internal/run-spec") {
  const base = (env[URL_ENV] ?? "").trim() || `http://${DEFAULT_HOST}:${(env[PORT_ENV] ?? "").trim() || DEFAULT_PORT}`;
  return `${base.replace(/\/+$/, "")}${path}`;
}

function asText(body) {
  return JSON.stringify(body);
}

export async function callRunSpec({ args, context, env, fetchFn = fetch, timeoutMs = CLIENT_TIMEOUT_MS }) {
  const token = (env[TOKEN_ENV] ?? "").trim();
  if (token === "") {
    return asText({ ok: false, code: "not-configured", message: `run_spec is not configured in this runtime (${TOKEN_ENV} is not set)` });
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (context.abort) signals.push(context.abort);
  let response;
  try {
    response = await fetchFn(endpointOf(env), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionID: context.sessionID, agent: context.agent, path: args.path, ...(args.grep ? { grep: args.grep } : {}) }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    // Nothing of the failure is quoted: a transport error can carry the address and headers.
    const reason = err && err.name === "TimeoutError" ? "timed out waiting for the orchestrator" : "could not reach the orchestrator";
    return asText({ ok: false, code: "unreachable", message: `run_spec ${reason}` });
  }
  const raw = await response.text().catch(() => "");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return asText({ ok: false, code: "bad-response", message: `run_spec got an answer it could not read (HTTP ${response.status})` });
  }
  return asText(body);
}
