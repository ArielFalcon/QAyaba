import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ApiErrorSchema } from "../../contract/commands";
import { routeApi } from "../api";
import type { ApiDeps } from "./deps";
import { routes } from "./route-table";

/* A token shaped like a GitHub personal access token, assembled so no source line holds a literal secret. */
const SECRET = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");

function mkReq(method: string, url: string, body = ""): any {
  const r: any = Readable.from(body ? [body] : []);
  r.method = method;
  r.url = url;
  r.headers = { host: "localhost" };
  r.socket = { remoteAddress: "127.0.0.1" };
  return r;
}

function mkRes(): any {
  return {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    headersSent: false,
    writeHead(s: number, h?: Record<string, string>) {
      this.status = s;
      this.headersSent = true;
      Object.assign(this.headers, h ?? {});
    },
    setHeader() {},
    write(c: string) {
      this.body += c;
    },
    end(b?: string) {
      this.body += b ?? "";
    },
    on() {},
  };
}

/* Every dependency a route reaches for fails with a message that carries a secret. */
function failingDeps(): ApiDeps {
  return new Proxy({}, { get: () => { throw new Error(`upstream rejected ${SECRET}`); } }) as ApiDeps;
}

function concretePath(path: string): string {
  return `/api/v1${path.replace(/:[A-Za-z]+/g, "x")}`;
}

for (const route of routes) {
  test(`${route.method} ${route.path}: a failing dependency answers an ApiError body with no secret in it`, async () => {
    const res = mkRes();
    await routeApi(mkReq(route.method, concretePath(route.path)), res, failingDeps());
    assert.ok(res.status >= 400, `status ${res.status}`);
    const body = ApiErrorSchema.parse(JSON.parse(res.body));
    assert.ok(body.error.length > 0);
    assert.ok(!res.body.includes(SECRET), "the secret reached the client");
    assert.ok(!/\n\s+at /.test(res.body), "a stack trace reached the client");
  });
}

test("a failure the route did not name answers a generic 500: no message, path or stack of the fault reaches the caller", async () => {
  const fault = `ENOENT: no such file or directory, open '/app/data/.api_token' ${SECRET}\n    at Object.run (/app/src/x.ts:10:5)`;
  const res = mkRes();
  await routeApi(mkReq("GET", "/api/queue"), res, { queue: { size: 0 }, currentRun: () => { throw new Error(fault); } } as unknown as ApiDeps);
  assert.equal(res.status, 500);
  assert.deepEqual(ApiErrorSchema.parse(JSON.parse(res.body)), { schemaVersion: 1, error: "internal error" });
});

test("an error a dependency throws while enqueueing a run reaches the client redacted", async () => {
  const deps = {
    loadApp: () => ({ name: "demo", repo: "org/demo" }),
    resolveRef: async () => "deadbeef1234",
    enqueue: () => { throw new Error(`queue failed ${SECRET}`); },
  } as unknown as ApiDeps;
  const res = mkRes();
  await routeApi(mkReq("POST", "/api/runs", JSON.stringify({ app: "demo" })), res, deps);
  assert.equal(res.status, 500);
  const body = ApiErrorSchema.parse(JSON.parse(res.body));
  assert.match(body.error, /^failed to enqueue run: queue failed/);
  assert.ok(!res.body.includes(SECRET));
});

test("a rejected request body carries its issues beside the message", async () => {
  const deps = { agentRuntime: {}, currentRun: () => undefined } as unknown as ApiDeps;
  const res = mkRes();
  await routeApi(mkReq("PUT", "/api/agent/config", JSON.stringify({ assignments: 5 })), res, deps);
  assert.equal(res.status, 400);
  const body = ApiErrorSchema.parse(JSON.parse(res.body));
  assert.equal(body.error, "invalid agent runtime config");
  assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
});

test("an app config the onboarding rules refuse answers 422 with every reason in the message and in errors", async () => {
  const deps = { createApp: async () => ({ ok: false, errors: ["bad url", "bad repo"] }) } as unknown as ApiDeps;
  const res = mkRes();
  await routeApi(mkReq("POST", "/api/apps", JSON.stringify({ repo: "org/x", name: "x" })), res, deps);
  assert.equal(res.status, 422);
  const body = ApiErrorSchema.parse(JSON.parse(res.body));
  assert.equal(body.error, "bad url; bad repo");
  assert.deepEqual(body.errors, ["bad url", "bad repo"]);
});

test("cancelling a run that is no longer the active one answers 409 in the error shape", async () => {
  const running = { id: "r1", status: "running", cases: [], logs: [] };
  const deps = { getRecord: () => running, cancelRun: () => false } as unknown as ApiDeps;
  const res = mkRes();
  await routeApi(mkReq("DELETE", "/api/runs/r1"), res, deps);
  assert.equal(res.status, 409);
  assert.match(ApiErrorSchema.parse(JSON.parse(res.body)).error, /no longer the active run/);
});
