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

/* The fakes above cannot tell whether the dispatcher and the fetch that uses it agree: Node's own fetch bundles one undici and the
   dispatcher comes from the installed one, and when their versions differ every request fails before it leaves. These requests go
   through the real transport to a server in this process, on the loopback interface. */
async function withLoopbackServer(fn: (base: string, seen: Array<{ method: string; url: string; body: string; auth: string | undefined }>) => Promise<void>): Promise<void> {
  const { createServer } = await import("node:http");
  const seen: Array<{ method: string; url: string; body: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the real agent transport reaches the server with the request's method, headers and body", async () => {
  await withLoopbackServer(async (base, seen) => {
    const agentFetch = createAgentTransportFetch();
    const posted = await agentFetch(new Request(`${base}/session/a/message`, { method: "POST", headers: { authorization: "Basic abc", "content-type": "application/json" }, body: JSON.stringify({ parts: [] }) }));
    const listed = await agentFetch(new Request(`${base}/agent`, { headers: { authorization: "Basic abc" } }));
    assert.equal(posted.status, 200);
    assert.deepEqual(await listed.json(), { ok: true });
    assert.deepEqual(seen, [
      { method: "POST", url: "/session/a/message", body: JSON.stringify({ parts: [] }), auth: "Basic abc" },
      { method: "GET", url: "/agent", body: "", auth: "Basic abc" },
    ]);
  });
});

test("a request the caller aborts through the real agent transport rejects", async () => {
  await withLoopbackServer(async (base) => {
    const agentFetch = createAgentTransportFetch();
    const controller = new AbortController();
    controller.abort(new Error("turn ended"));
    await assert.rejects(agentFetch(new Request(`${base}/agent`, { signal: controller.signal })));
  });
});

test("a request that never reaches the agent runtime says where it went and why", async () => {
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const agentFetch = createAgentTransportFetch();
  await assert.rejects(agentFetch(new Request(`http://127.0.0.1:${port}/agent`)), (err: Error) => {
    assert.match(err.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});
