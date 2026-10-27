import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createApp, LOGIN_ATTEMPTS_PER_WINDOW, type App, type AppDeps } from "./create-app";
import { MAX_WEBHOOK_BODY } from "./webhook-handler";
import { shouldLogApiRequest } from "./api-request-log";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SECRET = "hook-secret";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const running: App[] = [];

describe("createApp", () => {
  afterEach(async () => {
    await Promise.all(
      running.splice(0).flatMap((app) => [app.server, app.toolsServer].map((server) => new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve())))),
    );
  });

  interface Probe {
    app: App;
    base: string;
    enqueued: unknown[][];
    shutdowns: string[];
    listened: number;
    setShuttingDown(value: boolean): void;
  }

  async function start(over: { webhook?: Partial<AppDeps["webhook"]>; matches?: number } = {}): Promise<Probe> {
    const enqueued: unknown[][] = [];
    const shutdowns: string[] = [];
    let shuttingDown = false;
    const probe = { enqueued, shutdowns, listened: 0 } as Probe;
    const matches = Array.from({ length: over.matches ?? 1 }, (_, i) => ({ app: { name: `app-${i}` }, role: "primary" as const }));
    const app = createApp({
      control: {
        authorize: (req) => req.headers.authorization === "Bearer good",
        metrics: () => "",
        maintainer: async () => false,
        api: async (req, res) => {
          if (!/^\/api(\/v1)?\/(health|auth\/)/.test(req.url ?? "")) return false;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return true;
        },
        dashboard: async () => false,
        shouldLogApiRequest,
        log: () => {},
        now: () => 0,
      },
      webhook: {
        secret: undefined,
        allowUnsigned: false,
        catalog: { load: async () => { throw new Error("unused"); }, list: async () => [], resolveByRepo: async () => matches as never },
        enqueue: ((...args: unknown[]) => { enqueued.push(args); return "run"; }) as AppDeps["webhook"]["enqueue"],
        shuttingDown: () => shuttingDown,
        log: () => {},
        ...over.webhook,
      },
      toolsServer: createServer(),
      lifecycle: { shuttingDown: () => shuttingDown, setShuttingDown: (v) => { shuttingDown = v; }, shutdown: async (reason) => { shutdowns.push(reason); } },
      listen: { port: 0, host: "127.0.0.1", toolsPort: 0, toolsHost: "127.0.0.1", apiAuthOn: true },
      onListening: () => { probe.listened++; },
      log: () => {},
      exit: () => {},
      redact: (err) => String(err),
    });
    running.push(app);
    await app.listen();
    probe.app = app;
    probe.base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    probe.setShuttingDown = (v) => { shuttingDown = v; };
    return probe;
  }

  const sign = (body: string): string => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

  test("importing create-app starts nothing: a process that imports it has no handle left to keep it alive", async () => {
    const started = Date.now();
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./src/server/create-app.ts')"], { cwd: ROOT, timeout: 30_000 });
    assert.ok(Date.now() - started < 30_000);
  });

  test("building the app opens no listener until listen() is called", () => {
    const app = createApp({
      control: { authorize: () => false, metrics: () => "", maintainer: async () => false, api: async () => false, dashboard: async () => false, shouldLogApiRequest, log: () => {}, now: () => 0 },
      webhook: { secret: SECRET, allowUnsigned: false, catalog: { load: async () => { throw new Error("unused"); }, list: async () => [], resolveByRepo: async () => [] }, enqueue: (() => "") as never, shuttingDown: () => false, log: () => {} },
      toolsServer: createServer(),
      lifecycle: { shuttingDown: () => false, setShuttingDown: () => {}, shutdown: async () => {} },
      listen: { port: 0, host: "127.0.0.1", toolsPort: 0, toolsHost: "127.0.0.1", apiAuthOn: false },
      onListening: () => {},
      log: () => {},
      exit: () => {},
      redact: String,
    });
    assert.equal(app.server.listening, false);
    assert.equal(app.toolsServer.listening, false);
  });

  test("listen() starts both servers and runs the post-listen work once", async () => {
    const { app, listened } = await start();
    assert.equal(app.server.listening, true);
    assert.equal(app.toolsServer.listening, true);
    assert.equal(listened, 1);
  });

  test("an unauthenticated GET /api/runs answers 401 with the API error body, and the versioned health route is public", async () => {
    const { base } = await start();
    const denied = await fetch(`${base}/api/runs`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { schemaVersion: 1, error: "unauthorized" });
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  });

  test("the sign-in route answers 429 with Retry-After once one address used its attempts", async () => {
    const { base } = await start();
    let last: Response | undefined;
    for (let i = 0; i <= LOGIN_ATTEMPTS_PER_WINDOW; i++) last = await fetch(`${base}/api/auth/login`, { method: "POST" });
    assert.equal(last?.status, 429);
    assert.equal(last?.headers.get("retry-after"), "60");
  });

  test("a POST with no secret configured and no opt-in answers 401 with the fail-closed message", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { message: string }).message, /WEBHOOK_SECRET/);
  });

  test("a webhook body over the limit answers 413", async () => {
    const { base } = await start({ webhook: { secret: SECRET } });
    const res = await fetch(`${base}/`, { method: "POST", body: "x".repeat(MAX_WEBHOOK_BODY + 1) });
    assert.equal(res.status, 413);
  });

  test("a validly signed delivery enqueues once per dispatched app", async () => {
    const { base, enqueued } = await start({ webhook: { secret: SECRET }, matches: 2 });
    const body = JSON.stringify({ repo: "o/r", sha: SHA });
    const res = await fetch(`${base}/`, { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } });
    assert.equal(res.status, 202);
    assert.equal(enqueued.length, 2);
  });

  test("a delivery during shutdown answers 503 and enqueues nothing", async () => {
    const probe = await start({ webhook: { secret: SECRET } });
    probe.setShuttingDown(true);
    const body = JSON.stringify({ repo: "o/r", sha: SHA });
    const res = await fetch(`${probe.base}/`, { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } });
    assert.equal(res.status, 503);
    assert.equal(probe.enqueued.length, 0);
  });

  test("shutdown() runs the lifecycle's shutdown with the reason it was given", async () => {
    const probe = await start();
    await probe.app.shutdown("SIGTERM");
    assert.deepEqual(probe.shutdowns, ["SIGTERM"]);
  });

  test("a control plane that cannot bind reports through the exit hook and rejects listen()", async () => {
    const taken: Server = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const exits: number[] = [];
    const app = createApp({
      control: { authorize: () => false, metrics: () => "", maintainer: async () => false, api: async () => false, dashboard: async () => false, shouldLogApiRequest, log: () => {}, now: () => 0 },
      webhook: { secret: SECRET, allowUnsigned: false, catalog: { load: async () => { throw new Error("unused"); }, list: async () => [], resolveByRepo: async () => [] }, enqueue: (() => "") as never, shuttingDown: () => false, log: () => {} },
      toolsServer: createServer(),
      lifecycle: { shuttingDown: () => false, setShuttingDown: () => {}, shutdown: async () => {} },
      listen: { port: (taken.address() as AddressInfo).port, host: "127.0.0.1", toolsPort: 0, toolsHost: "127.0.0.1", apiAuthOn: false },
      onListening: () => {},
      log: () => {},
      exit: (code) => exits.push(code),
      redact: String,
    });
    running.push(app);
    await assert.rejects(app.listen());
    assert.deepEqual(exits, [1]);
    await new Promise<void>((resolve) => taken.close(() => resolve()));
  });
});
