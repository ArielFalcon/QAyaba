/* Which files implement each page: the map's own, else the engine's route node; a page the map does not list is the engine's; disagreements are reported once and the map decides. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFiles } from "@contexts/change-analysis/domain/page-files.ts";
import type { GraphRoute } from "@kernel/code/index.ts";

const ORDERS = "web/src/app/orders/orders.page.ts";
const node = (file: string, path: string, target?: string): GraphRoute => ({ file, line: 3, path, ...(target ? { target: { file: target, symbol: "X", kind: "class" as const } } : {}) });

test("where the map declares no file for a page, the engine's route node for the same path supplies it", () => {
  const home = "web/src/app/home/home.page.ts";

  const { files } = pageFiles({ routes: [{ path: "/home" }] }, [node("web/src/app/app.routes.ts", "home", home)]);

  assert.deepEqual(files.get("/home"), [home]);
});

test("a page the engine recognises that the map does not list, or no map at all, is implemented by its route node's file", () => {
  const routes = [node("web/src/app/app.routes.ts", "/cart", "web/src/app/cart/cart.page.ts")];

  assert.deepEqual(pageFiles({}, routes).files.get("/cart"), ["web/src/app/cart/cart.page.ts"]);
  assert.deepEqual(pageFiles({ routes: [{ path: "/orders", implementationFiles: [ORDERS] }] }, routes).files.get("/cart"), ["web/src/app/cart/cart.page.ts"]);
});

test("a page several frontends declare, and the map does not list, claims no engine file", () => {
  const routes = [node("apps/shop/src/app.routes.ts", "/orders", "apps/shop/o.ts"), node("apps/admin/src/app.routes.ts", "/orders", "apps/admin/o.ts")];

  assert.equal(pageFiles({}, routes).files.has("/orders"), false);
  assert.equal(pageFiles({ routes: [{ path: "/orders" }] }, routes).files.has("/orders"), false);
});

test("where the engine names a file the map does not list for a page, the disagreement is reported and the map's files still decide", () => {
  const { files, disagreements } = pageFiles({ routes: [{ path: "/orders", implementationFiles: [ORDERS] }] }, [node("web/src/app/app.routes.ts", "/orders", "web/src/app/orders/classic.page.ts")]);

  assert.deepEqual(files.get("/orders"), [ORDERS]);
  assert.deepEqual(disagreements, [{ route: "/orders", mapFiles: [ORDERS], engineFile: "web/src/app/orders/classic.page.ts" }]);
});

test("a map that lists a route twice reports one disagreement per engine file, not one per entry", () => {
  const map = { routes: [{ path: "/orders", implementationFiles: [ORDERS] }, { path: "/orders", implementationFiles: [ORDERS] }] };

  assert.equal(pageFiles(map, [node("web/src/app/app.routes.ts", "/orders", "web/src/app/orders/classic.page.ts")]).disagreements.length, 1);
});

test("in a monorepo with two frontends, a route the map leaves without files takes the engine's file of its own frontend only", () => {
  const routes = [node("apps/shop/src/app.routes.ts", "/orders", "apps/shop/src/orders/orders.page.ts"), node("apps/admin/src/app.routes.ts", "/orders", "apps/admin/src/orders/orders.page.ts")];

  const { files, disagreements } = pageFiles({ routes: [{ path: "/orders", source: "apps/admin/src/app.routes.ts" }] }, routes);

  assert.deepEqual(files.get("/orders"), ["apps/admin/src/orders/orders.page.ts"]);
  assert.deepEqual(disagreements, []);
});

test("a route node that points at no symbol supplies no file: the file that declares routes would otherwise reach every page", () => {
  const { files, disagreements } = pageFiles({ routes: [{ path: "/home" }] }, [node("web/src/app/app.routes.ts", "home")]);

  assert.equal(files.size, 0);
  assert.deepEqual(disagreements, []);
});

test("a map that is not what its type says is read field by field, never thrown on", () => {
  const map = { routes: [{ path: 3, implementationFiles: "x" }, null, { path: "/ok", implementationFiles: [7, ORDERS] }] } as never;

  assert.deepEqual([...pageFiles(map, []).files], [["/ok", [ORDERS]]]);
});
