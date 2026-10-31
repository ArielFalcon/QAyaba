/* How the orchestrator authenticates to `opencode serve`: the shared password from the environment, sent as HTTP
   Basic auth on every request, and a rejection answered loudly instead of read as an empty result. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { listAgentCaps, type AgentListDeps } from "./opencode-client";
import { OPENCODE_SERVER_PASSWORD_ENV, OpenCodeAuthError, openCodeServerAuth } from "./opencode-server-auth";

const PASSWORD = "p4ss-w0rd-with-entropy";

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("a missing password is refused at construction, naming the variable and never a value", () => {
  for (const env of [{}, { [OPENCODE_SERVER_PASSWORD_ENV]: "" }, { [OPENCODE_SERVER_PASSWORD_ENV]: "   " }]) {
    assert.throws(() => openCodeServerAuth(env), (error: unknown) => error instanceof OpenCodeAuthError && error.message.includes(OPENCODE_SERVER_PASSWORD_ENV));
  }
});

test("the password goes out as the Basic credential of the opencode user", () => {
  const { headers } = openCodeServerAuth({ [OPENCODE_SERVER_PASSWORD_ENV]: PASSWORD });
  assert.equal(headers.Authorization, basic("opencode", PASSWORD));
});

test("a request the server accepts passes through untouched", async () => {
  const seen: Request[] = [];
  const { fetch } = openCodeServerAuth({ [OPENCODE_SERVER_PASSWORD_ENV]: PASSWORD }, async (request) => {
    seen.push(request);
    return new Response("{}", { status: 200 });
  });
  const response = await fetch(new Request("http://agents.invalid:4096/agent"));
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
});

test("a 401 is thrown as an auth failure that says which variable to align and never carries the password", async () => {
  const { fetch } = openCodeServerAuth({ [OPENCODE_SERVER_PASSWORD_ENV]: PASSWORD }, async () => new Response("", { status: 401 }));
  await assert.rejects(fetch(new Request("http://agents.invalid:4096/agent")), (error: unknown) => {
    assert.ok(error instanceof OpenCodeAuthError);
    assert.ok(error.message.includes(OPENCODE_SERVER_PASSWORD_ENV), "the message names the variable to align on both services");
    assert.ok(!error.message.includes(PASSWORD), "the password is never put in a message");
    return true;
  });
});

test("other failures are not auth failures: a 500 passes through for the caller's own error handling", async () => {
  const { fetch } = openCodeServerAuth({ [OPENCODE_SERVER_PASSWORD_ENV]: PASSWORD }, async () => new Response("boom", { status: 500 }));
  assert.equal((await fetch(new Request("http://agents.invalid:4096/agent"))).status, 500);
});

test("through the real SDK client, a rejected password surfaces from the agent list as an error naming the variable", async () => {
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const auth = openCodeServerAuth({ [OPENCODE_SERVER_PASSWORD_ENV]: PASSWORD }, async () => new Response("", { status: 401 }));
  const client = createOpencodeClient({ baseUrl: "http://agents.invalid:4096", headers: auth.headers, fetch: auth.fetch as typeof fetch });
  const deps: AgentListDeps = { getClient: async () => client };
  await assert.rejects(listAgentCaps("/m/app", deps), (error: unknown) => error instanceof Error && error.message.includes(OPENCODE_SERVER_PASSWORD_ENV) && !error.message.includes(PASSWORD));
});
