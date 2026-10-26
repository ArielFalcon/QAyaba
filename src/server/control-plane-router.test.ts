import { afterEach, test } from "node:test";
import { ApiErrorSchema } from "../contract/commands";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createControlPlaneHandler, type ControlPlaneDeps } from "./control-plane-router";
import { createFixedWindowLimiter } from "./rate-limit";
import { shouldLogApiRequest } from "./api-request-log";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function answer(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

async function start(over: Partial<ControlPlaneDeps> = {}) {
  const seen = { api: [] as string[], webhook: 0, logs: [] as string[] };
  const deps: ControlPlaneDeps = {
    authorize: (req: IncomingMessage) => req.headers.authorization === "Bearer good",
    loginLimiter: createFixedWindowLimiter({ limit: 20, windowMs: 60_000 }),
    metrics: () => "qayaba_queue_depth 0",
    maintainer: async () => false,
    api: async (req, res) => {
      seen.api.push(req.url ?? "");
      /* handleApi owns the version prefix itself; the fake does the same. */
      if (/^\/api(\/v1)?\/(runs|health|version|auth\/)/.test(req.url ?? "")) {
        answer(res, 200, "api");
        return true;
      }
      return false;
    },
    dashboard: async (_req, res) => { answer(res, 200, "console"); return true; },
    webhook: (_req, res) => { seen.webhook++; answer(res, 202, "hook"); },
    shouldLogApiRequest,
    log: (_level, message) => seen.logs.push(message),
    now: () => 1_000,
    ...over,
  };
  const handler = createControlPlaneHandler(deps);
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const GOOD = { authorization: "Bearer good" };

test("an unauthenticated API request is answered 401 in the API error shape", async () => {
  const { base, seen } = await start();
  const res = await fetch(`${base}/api/runs`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { schemaVersion: 1, error: "unauthorized" });
  assert.equal(seen.api.length, 0, "the API is never reached without authorization");
});

test("liveness and the version handshake are public, under both the plain and the versioned prefix", async () => {
  const { base } = await start();
  for (const path of ["/api/health", "/api/v1/health", "/api/version", "/api/v1/version"]) {
    assert.notEqual((await fetch(`${base}${path}`)).status, 401, path);
  }
});

test("the versioned prefix reaches the same routes as the plain one for an authorized caller", async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/api/v1/runs`, { headers: GOOD })).status, 200);
  assert.equal((await fetch(`${base}/api/runs`, { headers: GOOD })).status, 200);
});

test("the twenty-first sign-in from one address in a minute is answered 429 with Retry-After", async () => {
  const { base } = await start();
  let last: Response | undefined;
  for (let i = 0; i < 21; i++) last = await fetch(`${base}/api/auth/login`, { method: "POST" });
  assert.equal(last?.status, 429);
  assert.equal(last?.headers.get("retry-after"), "60");
  const body = ApiErrorSchema.parse(await last?.json());
  assert.match(body.error, /too many login attempts/);
});

test("the first twenty sign-ins pass the throttle", async () => {
  const { base } = await start();
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST" })).status, 200);
});

test("metrics are plain text and need authorization", async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/api/metrics`)).status, 401);
  const res = await fetch(`${base}/api/metrics`, { headers: GOOD });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(await res.text(), /qayaba_queue_depth/);
});

test("a maintainer route nobody handled is answered 404 and one that was handled is left to its handler", async () => {
  const unhandled = await start();
  assert.equal((await fetch(`${unhandled.base}/api/maintainer/status`, { headers: GOOD })).status, 404);
  const handled = await start({ maintainer: async (_req, res) => { answer(res, 200, "maintainer"); return true; } });
  assert.equal(await (await fetch(`${handled.base}/api/maintainer/status`, { headers: GOOD })).text(), "maintainer");
});

test("an API path no route matches is answered 404 in the API error shape", async () => {
  const { base } = await start();
  const res = await fetch(`${base}/api/nope`, { headers: GOOD });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { schemaVersion: 1, error: "not found" });
});

test("a write that is answered is logged and a successful read is not", async () => {
  const { base, seen } = await start();
  await fetch(`${base}/api/runs`, { headers: GOOD });
  assert.equal(seen.logs.length, 0);
  await fetch(`${base}/api/runs`, { method: "POST", headers: GOOD });
  assert.equal(seen.logs.length, 1);
});

test("CORS preflight is answered 204 without authorization", async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/api/runs`, { method: "OPTIONS" })).status, 204);
});

test("the web console is served under /app and a POST elsewhere goes to the webhook", async () => {
  const { base, seen } = await start();
  assert.equal(await (await fetch(`${base}/app/index.html`)).text(), "console");
  assert.equal((await fetch(`${base}/`, { method: "POST", body: "{}" })).status, 202);
  assert.equal(seen.webhook, 1);
});

test("any other path is answered 404", async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
});
