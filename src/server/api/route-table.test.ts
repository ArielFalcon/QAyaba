import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { buildOpenApiDocument } from "../../contract/openapi";
import { ApiErrorSchema } from "../../contract/commands";
import { routeApi } from "../api";
import type { ApiDeps } from "./deps";
import { isPublicRoute, matchRoute, normalizeApiPath, routes } from "./route-table";

function match(method: string, path: string) {
  return matchRoute(method, normalizeApiPath(path));
}

test("the versioned and the unversioned path reach the same route with the same parameters", () => {
  const versioned = match("GET", "/api/v1/runs/abc/events");
  const plain = match("GET", "/api/runs/abc/events");
  assert.equal(versioned.kind, "matched");
  assert.equal(plain.kind, "matched");
  if (versioned.kind !== "matched" || plain.kind !== "matched") return;
  assert.equal(versioned.route, plain.route);
  assert.deepEqual(versioned.params, { id: "abc" });
  assert.deepEqual(plain.params, { id: "abc" });
});

test("a path no route has matches nothing", () => {
  assert.equal(match("GET", "/api/nope").kind, "none");
  assert.equal(match("GET", "/api").kind, "none");
  assert.equal(match("GET", "/api/runs/").kind, "none");
  assert.equal(match("GET", "/api/runs//events").kind, "none");
  assert.equal(match("GET", "/api/runs/a/events/extra").kind, "none");
});

test("a known path asked with another method lists the methods it does take", () => {
  const result = match("PATCH", "/api/apps/demo");
  assert.equal(result.kind, "method-not-allowed");
  if (result.kind !== "method-not-allowed") return;
  assert.deepEqual([...result.allow].sort(), ["DELETE", "GET", "PUT"]);
});

test("an encoded slash stays inside its segment and a literal slash adds one", () => {
  const encoded = match("GET", "/api/runs/a%2Fb/events");
  assert.equal(encoded.kind, "matched");
  if (encoded.kind === "matched") assert.equal(encoded.params.id, "a%2Fb");
  assert.equal(match("GET", "/api/runs/a/b/events").kind, "none");
});

test("only the liveness probe, the version handshake and the two sign-in routes are public", () => {
  const open = routes.filter((r) => r.auth === "public").map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(open, ["GET /auth/local", "GET /health", "GET /version", "POST /auth/login"]);
  assert.equal(isPublicRoute("GET", "/api/health"), true);
  assert.equal(isPublicRoute("POST", "/api/auth/local"), false);
  assert.equal(isPublicRoute("GET", "/api/apps"), false);
});

/* Routes the contract leaves out on purpose, by "METHOD path" under /api. */
const NOT_IN_CONTRACT = new Set(["GET /health"]);

function contractOperations(): Set<string> {
  const paths = buildOpenApiDocument().paths as Record<string, Record<string, unknown>>;
  const out = new Set<string>();
  for (const [path, operations] of Object.entries(paths)) {
    for (const method of Object.keys(operations)) out.add(`${method.toUpperCase()} ${path.replace(/^\/api\/v1/, "").replace(/\{[^}]+\}/g, ":p")}`);
  }
  return out;
}

function tableOperations(): Set<string> {
  return new Set(routes.map((r) => `${r.method} ${r.path.replace(/:[A-Za-z]+/g, ":p")}`));
}

test("every route of the table is in the OpenAPI contract and every contract operation has a route", () => {
  const contract = contractOperations();
  const table = tableOperations();
  const undocumented = [...table].filter((op) => !contract.has(op) && !NOT_IN_CONTRACT.has(op));
  const unserved = [...contract].filter((op) => !table.has(op));
  assert.deepEqual(undocumented, []);
  assert.deepEqual(unserved, []);
});

function mkRes(): any {
  return {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(s: number, h?: Record<string, string>) {
      this.status = s;
      Object.assign(this.headers, h ?? {});
    },
    end(b?: string) {
      this.body = b ?? "";
    },
  };
}

test("a known path with the wrong method answers 405 in the error shape and names the allowed methods", async () => {
  const req: any = Readable.from([]);
  req.method = "PATCH";
  req.url = "/api/v1/apps/demo";
  req.headers = { host: "localhost" };
  const res = mkRes();
  const handled = await routeApi(req, res, {} as ApiDeps);
  assert.equal(handled, true);
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, "GET, PUT, DELETE");
  assert.doesNotThrow(() => ApiErrorSchema.parse(JSON.parse(res.body)));
});

test("a path no route has is left to the caller", async () => {
  const req: any = Readable.from([]);
  req.method = "GET";
  req.url = "/api/nope";
  req.headers = { host: "localhost" };
  const res = mkRes();
  assert.equal(await routeApi(req, res, {} as ApiDeps), false);
  assert.equal(res.status, 0);
});
