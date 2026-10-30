/* The agent transport holds no deadline of its own: a prompt to `opencode serve` is one request held open until the
   turn answers, and only the turn's own limit (or the run's deadline) ends it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTransportFetch } from "./net";

test("the agent transport sends every request through a dispatcher with no headers or body deadline", async () => {
  const built: Array<Record<string, unknown>> = [];
  const dispatcher = { name: "agent-dispatcher" };
  const sent: Array<{ request: Request; dispatcher: unknown }> = [];
  const agentFetch = createAgentTransportFetch({
    makeDispatcher: (options) => {
      built.push(options);
      return dispatcher;
    },
    fetch: async (request, init) => {
      sent.push({ request, dispatcher: init.dispatcher });
      return new Response("{}", { status: 200 });
    },
  });

  await agentFetch(new Request("http://agents.invalid:4096/session/a/message", { method: "POST" }));
  await agentFetch(new Request("http://agents.invalid:4096/agent"));

  assert.deepEqual(built, [{ headersTimeout: 0, bodyTimeout: 0 }]);
  assert.deepEqual(sent.map((s) => s.dispatcher), [dispatcher, dispatcher]);
  assert.deepEqual(sent.map((s) => s.request.url), ["http://agents.invalid:4096/session/a/message", "http://agents.invalid:4096/agent"]);
});
