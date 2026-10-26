import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWebhookHandler, MAX_WEBHOOK_BODY, type WebhookHandlerDeps } from "./webhook-handler";

const SECRET = "hook-secret";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type Match = { app: { name: string; code?: unknown }; role: "primary" | "service" };

async function start(over: Partial<WebhookHandlerDeps> & { matches?: Match[]; resolveFails?: boolean } = {}) {
  const enqueued: unknown[][] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const handler = createWebhookHandler({
    secret: SECRET,
    allowUnsigned: false,
    catalog: {
      load: async () => { throw new Error("unused"); },
      list: async () => [],
      resolveByRepo: async () => {
        if (over.resolveFails) throw new Error("catalog unavailable");
        return (over.matches ?? [{ app: { name: "shop" }, role: "primary" }]) as never;
      },
    },
    enqueue: ((...args: unknown[]) => { enqueued.push(args); return "run-1"; }) as WebhookHandlerDeps["enqueue"],
    shuttingDown: () => false,
    log: (level, message) => logs.push({ level, message }),
    ...over,
  });
  const server = createServer((req, res) => handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { url, enqueued, logs };
}

const sign = (body: string, secret = SECRET): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: { message?: string } }> {
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, body: (await res.json()) as { message?: string } };
}

test("a delivery is refused when no secret is configured and unsigned deliveries are not allowed", async () => {
  const { url, enqueued } = await start({ secret: undefined, allowUnsigned: false });
  const res = await post(url, JSON.stringify({ repo: "o/r", sha: SHA }));
  assert.equal(res.status, 401);
  assert.match(res.body.message ?? "", /WEBHOOK_SECRET/);
  assert.equal(enqueued.length, 0);
});

test("an unsigned delivery is accepted when the operator opted in", async () => {
  const { url, enqueued } = await start({ secret: undefined, allowUnsigned: true });
  const res = await post(url, JSON.stringify({ repo: "o/r", sha: SHA }));
  assert.equal(res.status, 202);
  assert.equal(enqueued.length, 1);
});

test("a body over the limit is answered 413 and enqueues nothing", async () => {
  const { url, enqueued } = await start({ maxBody: 64 });
  const res = await post(url, JSON.stringify({ repo: "o/r", sha: SHA, guidance: "x".repeat(200) }), { "x-hub-signature-256": "sha256=00" });
  assert.equal(res.status, 413);
  assert.equal(enqueued.length, 0);
  assert.ok(MAX_WEBHOOK_BODY > 64, "the production limit is a real bound");
});

test("a signed delivery enqueues one run per app it dispatches to", async () => {
  const { url, enqueued } = await start({ matches: [{ app: { name: "shop" }, role: "primary" }, { app: { name: "admin" }, role: "service" }] });
  const body = JSON.stringify({ repo: "o/shop", sha: SHA });
  const res = await post(url, body, { "x-hub-signature-256": sign(body) });
  assert.equal(res.status, 202);
  assert.equal(enqueued.length, 2);
  assert.deepEqual(enqueued.map((args) => args[0]), ["shop", "admin"]);
  assert.ok(enqueued.every((args) => args[1] === SHA));
});

test("a delivery with a wrong signature is refused and enqueues nothing", async () => {
  const { url, enqueued } = await start();
  const body = JSON.stringify({ repo: "o/shop", sha: SHA });
  const res = await post(url, body, { "x-hub-signature-256": sign(body, "another-secret") });
  assert.equal(res.status, 401);
  assert.equal(res.body.message, "invalid signature");
  assert.equal(enqueued.length, 0);
});

test("a delivery during shutdown is answered 503 and enqueues nothing", async () => {
  const { url, enqueued } = await start({ shuttingDown: () => true });
  const body = JSON.stringify({ repo: "o/shop", sha: SHA });
  const res = await post(url, body, { "x-hub-signature-256": sign(body) });
  assert.equal(res.status, 503);
  assert.equal(enqueued.length, 0);
});

test("a repository no app watches is acknowledged and logged as ignored", async () => {
  const { url, enqueued, logs } = await start({ matches: [] });
  const body = JSON.stringify({ repo: "o/unknown", sha: SHA });
  const res = await post(url, body, { "x-hub-signature-256": sign(body) });
  assert.equal(res.status, 202);
  assert.equal(enqueued.length, 0);
  assert.ok(logs.some((entry) => entry.level === "warn"));
});

test("a catalog failure is answered 500 and logged, and an enqueue failure is answered 500", async () => {
  const body = JSON.stringify({ repo: "o/shop", sha: SHA });
  const headers = { "x-hub-signature-256": sign(body) };
  const failingCatalog = await start({ resolveFails: true });
  const first = await post(failingCatalog.url, body, headers);
  assert.equal(first.status, 500);
  assert.ok(failingCatalog.logs.some((entry) => entry.level === "error"));
  const failingEnqueue = await start({ enqueue: (() => { throw new Error("queue closed"); }) as WebhookHandlerDeps["enqueue"] });
  const second = await post(failingEnqueue.url, body, headers);
  assert.equal(second.status, 500);
});

test("a body that is not JSON is answered 400 and one without a repository and commit is answered 422", async () => {
  const { url } = await start();
  const notJson = "not json";
  assert.equal((await post(url, notJson, { "x-hub-signature-256": sign(notJson) })).status, 400);
  const empty = JSON.stringify({ hello: "world" });
  assert.equal((await post(url, empty, { "x-hub-signature-256": sign(empty) })).status, 422);
});
