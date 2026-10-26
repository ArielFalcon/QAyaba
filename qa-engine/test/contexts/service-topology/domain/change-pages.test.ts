/* The pages the call graph proves a change reaches: always pages the map names, each with its shortest proof; a hub adds none, the cap bounds what the graph adds, the map's own pages are never displaced, and a map/engine disagreement is reported. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRAPH_PAGE_LIMITS, joinChangePages, type ChangePagesInput, type PageWalk } from "@contexts/service-topology/domain/change-pages.ts";
import type { GraphRoute, ImpactedSymbol } from "@kernel/code/index.ts";

const FORMAT = "web/src/app/shared/format.ts";
const ORDERS = "web/src/app/orders/orders.page.ts";
const PROFILE = "web/src/app/profile/profile.page.ts";

const sym = (file: string, symbol: string, depth: number, via?: { file: string; symbol: string }): ImpactedSymbol => ({ file, symbol, kind: "function", depth, ...(via ? { via } : {}) });
const walk = (reached: ImpactedSymbol[], extra: Partial<PageWalk> = {}): PageWalk => ({ reached, handlers: false, ...extra });

const MAP = {
  routes: [
    { path: "/orders", implementationFiles: [ORDERS] },
    { path: "/profile", implementationFiles: [PROFILE] },
    { path: "/home" },
  ],
  api: [{ operationId: "listOrders", method: "GET", path: "/api/orders" }],
  feBe: [{ route: "/orders", operationId: "listOrders" }],
};

const input = (over: Partial<ChangePagesInput>): ChangePagesInput => ({ map: MAP, walks: [], pageRoutes: [], handlerRoutes: [], linked: new Set(), ...over });

test("a changed symbol reached by a page's implementation proves that page, with the path from the change to the page", () => {
  const reached = [sym(FORMAT, "formatMoney", 0), sym(ORDERS, "total", 1, { file: FORMAT, symbol: "formatMoney" })];

  const join = joinChangePages(input({ walks: [walk(reached)] }));

  assert.deepEqual(join.pages, [{ route: "/orders", proof: [`${FORMAT}::formatMoney`, `${ORDERS}::total`, "page /orders"] }]);
  assert.deepEqual(join.hubs, []);
  assert.equal(join.omitted, 0);
});

test("a page the map already links is never added again and takes no slot", () => {
  const reached = [sym(FORMAT, "formatMoney", 0), sym(ORDERS, "total", 1, { file: FORMAT, symbol: "formatMoney" }), sym(PROFILE, "balance", 1, { file: FORMAT, symbol: "formatMoney" })];

  const join = joinChangePages(input({ walks: [walk(reached)], linked: new Set(["/orders"]), limits: { maxPages: 1, hubPages: 4 } }));

  assert.deepEqual(join.pages.map((p) => p.route), ["/profile"]);
  assert.equal(join.omitted, 0);
});

test("where the map declares no file for a page, the engine's route node for the same path supplies it", () => {
  const home = "web/src/app/home/home.page.ts";
  const pageRoutes: GraphRoute[] = [{ file: "web/src/app/app.routes.ts", line: 3, path: "home", target: { file: home, symbol: "HomePage", kind: "class" } }];
  const reached = [sym(FORMAT, "formatMoney", 0), sym(home, "HomePage", 1, { file: FORMAT, symbol: "formatMoney" })];

  const join = joinChangePages(input({ walks: [walk(reached)], pageRoutes }));

  assert.deepEqual(join.pages.map((p) => p.route), ["/home"]);
});

test("where the engine names a file the map does not list for a page, the disagreement is reported and the map's files still decide", () => {
  const pageRoutes: GraphRoute[] = [{ file: "web/src/app/app.routes.ts", line: 3, path: "/orders", target: { file: "web/src/app/orders/classic.page.ts", symbol: "Classic", kind: "class" } }];
  const reached = [sym(FORMAT, "formatMoney", 0), sym("web/src/app/orders/classic.page.ts", "Classic", 1, { file: FORMAT, symbol: "formatMoney" })];

  const join = joinChangePages(input({ walks: [walk(reached)], pageRoutes }));

  assert.deepEqual(join.pages, [], "the engine's file does not override the map's");
  assert.deepEqual(join.disagreements, [{ route: "/orders", mapFiles: [ORDERS], engineFile: "web/src/app/orders/classic.page.ts" }], "the file that declares the route is the map's source, never a disagreement");
});

test("a reached handler whose route serves a map operation reaches the pages feBe joins to it, by verb and path or by its operationId", () => {
  const controller = "api/src/main/java/demo/web/OrderController.java";
  const handlerRoutes: GraphRoute[] = [{ file: controller, line: 16, method: "GET", path: "/orders", target: { file: controller, symbol: "listAll", kind: "method" } }];
  const byPath = joinChangePages(input({ walks: [walk([sym(controller, "listAll", 0)], { handlers: true })], handlerRoutes }));
  assert.deepEqual(byPath.pages, [{ route: "/orders", proof: [`${controller}::listAll`, "GET /api/orders (listOrders)", "page /orders"] }]);

  const generated = joinChangePages(input({ walks: [walk([sym(controller, "listOrders", 0)], { handlers: true })], handlerRoutes: [{ ...handlerRoutes[0]!, path: "/elsewhere", target: { file: controller, symbol: "listOrders", kind: "method" } }] }));
  assert.deepEqual(generated.pages.map((p) => p.route), ["/orders"]);

  const notForThisRepo = joinChangePages(input({ walks: [walk([sym(controller, "listAll", 0)])], handlerRoutes }));
  assert.deepEqual(notForThisRepo.pages, [], "the handler proof applies only to the repo the map's operations belong to");
});

test("across repos a walk from a link's call site opens its proof with the link", () => {
  const api = "web/src/app/orders/orders.api.ts";
  const reached = [sym(api, "fetchOrders", 0), sym(ORDERS, "load", 1, { file: api, symbol: "fetchOrders" })];

  const join = joinChangePages(input({ walks: [walk(reached, { prefixOf: new Map([[`${api}::fetchOrders`, ["org/orders-api: GET /api/orders"]]]) })] }));

  assert.deepEqual(join.pages, [{ route: "/orders", proof: ["org/orders-api: GET /api/orders", `${api}::fetchOrders`, `${ORDERS}::load`, "page /orders"] }]);
});

test("a changed symbol that reaches more pages than the hub bound adds none and is reported with its count; another seed still proves its pages", () => {
  const routes = ["a", "b", "c", "d", "e"].map((n) => ({ path: `/${n}`, implementationFiles: [`web/src/app/${n}/${n}.page.ts`] }));
  const hub = sym("web/src/app/shared/http.ts", "request", 0);
  const reached = [hub, ...routes.map((r) => sym(r.implementationFiles[0]!, "Page", 1, { file: hub.file, symbol: hub.symbol })), sym(FORMAT, "formatMoney", 0), sym("web/src/app/a/a.page.ts", "fmt", 1, { file: FORMAT, symbol: "formatMoney" })];

  const join = joinChangePages(input({ map: { routes }, walks: [walk(reached)] }));

  assert.deepEqual(join.hubs, [{ symbol: "web/src/app/shared/http.ts::request", pages: 5, routes: ["/a", "/b", "/c", "/d", "/e"] }]);
  assert.deepEqual(join.pages.map((p) => p.route), ["/a"]);
  assert.equal(GRAPH_PAGE_LIMITS.hubPages < 5, true, "the fixture exceeds the declared bound");
});

test("the graph adds at most the cap, shortest proof first, and counts what it left out", () => {
  const routes = ["a", "b", "c"].map((n) => ({ path: `/${n}`, implementationFiles: [`web/src/app/${n}/${n}.page.ts`] }));
  const reached = [
    sym("web/src/app/a/a.page.ts", "A", 0),
    sym("web/src/x.ts", "x", 0),
    sym("web/src/app/b/b.page.ts", "B", 1, { file: "web/src/x.ts", symbol: "x" }),
    sym("web/src/y.ts", "y", 0),
    sym("web/src/y2.ts", "y2", 1, { file: "web/src/y.ts", symbol: "y" }),
    sym("web/src/app/c/c.page.ts", "C", 2, { file: "web/src/y2.ts", symbol: "y2" }),
  ];

  const join = joinChangePages(input({ map: { routes }, walks: [walk(reached)], limits: { maxPages: 2, hubPages: 4 } }));

  assert.deepEqual(join.pages.map((p) => p.route), ["/a", "/b"]);
  assert.equal(join.omitted, 1);
});

test("a map that is not what its type says is read field by field, never thrown on", () => {
  const map = { routes: [{ path: 3, implementationFiles: "x" }, null as never, { path: "/ok", implementationFiles: [7, ORDERS] }], api: [{ operationId: 1 }], feBe: [{}] };
  const join = joinChangePages(input({ map, walks: [walk([sym(ORDERS, "total", 0)], { handlers: true })] }));
  assert.deepEqual(join.pages.map((p) => p.route), ["/ok"]);
});

test("a route node that points at no symbol supplies no file: the file that declares routes would otherwise reach every page", () => {
  const pageRoutes: GraphRoute[] = [{ file: "web/src/app/app.routes.ts", line: 3, path: "home" }];
  const join = joinChangePages(input({ walks: [walk([sym("web/src/app/app.routes.ts", "routes", 0)])], pageRoutes }));
  assert.deepEqual(join.pages, []);
  assert.deepEqual(join.disagreements, []);
});

test("a reached symbol named for an operationId proves the pages feBe joins to it with no route node: a generated contract interface yields none", () => {
  const impl = "api/src/main/java/demo/web/OrdersApiImpl.java";
  const join = joinChangePages(input({ walks: [walk([sym(impl, "listOrders", 0)], { handlers: true })] }));
  assert.deepEqual(join.pages, [{ route: "/orders", proof: [`${impl}::listOrders`, "GET /api/orders (listOrders)", "page /orders"] }]);
});

test("a map that lists a route twice reports one disagreement per engine file, not one per entry", () => {
  const map = { routes: [{ path: "/orders", implementationFiles: [ORDERS] }, { path: "/orders", implementationFiles: [ORDERS] }] };
  const pageRoutes: GraphRoute[] = [{ file: "web/src/app/app.routes.ts", line: 3, path: "/orders", target: { file: "web/src/app/orders/classic.page.ts", symbol: "Classic", kind: "class" } }];
  assert.equal(joinChangePages(input({ map, pageRoutes })).disagreements.length, 1);
});

test("in a monorepo with two frontends, a route the map leaves without files takes the engine's file of its own frontend only", () => {
  const shopPage = "apps/shop/src/orders/orders.page.ts";
  const adminPage = "apps/admin/src/orders/orders.page.ts";
  const pageRoutes: GraphRoute[] = [
    { file: "apps/shop/src/app.routes.ts", line: 3, path: "/orders", target: { file: shopPage, symbol: "ShopOrders", kind: "class" } },
    { file: "apps/admin/src/app.routes.ts", line: 3, path: "/orders", target: { file: adminPage, symbol: "AdminOrders", kind: "class" } },
  ];
  const map = { routes: [{ path: "/orders", source: "apps/admin/src/app.routes.ts" }] };

  const adminChange = joinChangePages(input({ map, pageRoutes, walks: [walk([sym(adminPage, "AdminOrders", 0)])] }));
  assert.deepEqual(adminChange.pages.map((p) => p.route), ["/orders"]);

  const shopChange = joinChangePages(input({ map, pageRoutes, walks: [walk([sym(shopPage, "ShopOrders", 0)])] }));
  assert.deepEqual(shopChange.pages, [], "another frontend's page of the same path is not this app's page");
  assert.deepEqual(shopChange.disagreements, []);
});

test("a route that several frontends declare and a map that names no source claims no engine file", () => {
  const pageRoutes: GraphRoute[] = [
    { file: "apps/shop/src/app.routes.ts", line: 3, path: "/orders", target: { file: "apps/shop/o.ts", symbol: "A", kind: "class" } },
    { file: "apps/admin/src/app.routes.ts", line: 3, path: "/orders", target: { file: "apps/admin/o.ts", symbol: "B", kind: "class" } },
  ];
  const join = joinChangePages(input({ map: { routes: [{ path: "/orders" }] }, pageRoutes, walks: [walk([sym("apps/shop/o.ts", "A", 0)])] }));
  assert.deepEqual(join.pages, []);
});

test("a walk the budget cut cannot prove a seed is no hub: its pages are not added and it is reported", () => {
  const reached = [sym(FORMAT, "formatMoney", 0), sym(ORDERS, "total", 1, { file: FORMAT, symbol: "formatMoney" })];

  const join = joinChangePages(input({ walks: [walk(reached, { truncated: true })] }));

  assert.deepEqual(join.pages, []);
  assert.deepEqual(join.hubs, [{ symbol: `${FORMAT}::formatMoney`, pages: 1, routes: ["/orders"], truncated: true }]);

  const complete = joinChangePages(input({ walks: [walk(reached, { truncated: false })] }));
  assert.deepEqual(complete.pages.map((p) => p.route), ["/orders"]);
  assert.deepEqual(complete.hubs, []);
});
