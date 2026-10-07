/* The order in which the pack offers the map's routes to the capture: the ones the run's changed files point at come first. The map is data read from a file, so each field can hold any shape; entries here are plain records and the map type is claimed once. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTE_LINK_FIELDS, rankRoutesByChange } from "@contexts/generation/domain/route-ranking.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";

const { implementationFiles: IMPLEMENTATION, source: SOURCE, spec: SPEC } = ROUTE_LINK_FIELDS;

type Entry = Record<string, unknown>;
const mapOf = (routes: unknown, api: unknown = [], feBe: unknown = []): ArchitectureContext =>
  ({ builtAtSha: "abc1234", routes, api, feBe }) as unknown as ArchitectureContext;
const route = (path: string, links: Entry = {}): Entry => ({ path, ...links });
const operation = (operationId: string, links: Entry = {}): Entry => ({ operationId, method: "GET", path: `/${operationId}`, ...links });
const joins = (routePath: string, operationId: string): Entry => ({ route: routePath, operationId });

/* An order no sort would produce, so a route that keeps its place did not get there by accident. */
const FILE_ORDER = ["/m", "/z", "/b", "/y", "/a"];

test("routes come first by what links them to a changed file: implementation files, then the declaring source, then the spec of an operation they join, then the rest", () => {
  const map = mapOf(
    [
      route("/plain"),
      route("/by-spec"),
      route("/by-source", { [SOURCE]: "src/pages/orders.ts" }),
      route("/by-implementation", { [IMPLEMENTATION]: ["src/components/cart-view.ts", "src/pages/cart.ts"] }),
    ],
    [operation("listOrders", { [SPEC]: "api/orders.yaml" })],
    [joins("/by-spec", "listOrders")],
  );
  const changedFiles = ["src/pages/cart.ts", "src/pages/orders.ts", "api/orders.yaml"];

  const ranked = rankRoutesByChange(["/plain", "/by-spec", "/by-source", "/by-implementation"], map, { changedFiles });

  assert.deepEqual(ranked, ["/by-implementation", "/by-source", "/by-spec", "/plain"]);
});

test("within a rank the routes keep the order of the file, and so do the routes nothing links", () => {
  const map = mapOf(FILE_ORDER.map((path) => route(path, path === "/z" || path === "/y" ? { [SOURCE]: "src/pages/cart.ts" } : {})));

  assert.deepEqual(rankRoutesByChange(FILE_ORDER, map, { changedFiles: ["src/pages/cart.ts"] }), ["/z", "/y", "/m", "/b", "/a"]);
});

test("a route linked in several ways takes its best rank once, and no route is lost or repeated", () => {
  const map = mapOf([
    route("/x"),
    route("/both", { [IMPLEMENTATION]: ["src/pages/cart.ts"], [SOURCE]: "src/pages/orders.ts" }),
    route("/y", { [SOURCE]: "src/pages/orders.ts" }),
  ]);

  const ranked = rankRoutesByChange(["/x", "/both", "/y"], map, { changedFiles: ["src/pages/cart.ts", "src/pages/orders.ts"] });

  assert.deepEqual(ranked, ["/both", "/y", "/x"]);
});

test("a route linked by its source and by a spec ranks with the source, ahead of a route linked by a spec alone", () => {
  const map = mapOf(
    [route("/spec-only"), route("/source-and-spec", { [SOURCE]: "src/pages/orders.ts" })],
    [operation("listOrders", { [SPEC]: "api/orders.yaml" })],
    [joins("/spec-only", "listOrders"), joins("/source-and-spec", "listOrders")],
  );

  assert.deepEqual(rankRoutesByChange(["/spec-only", "/source-and-spec"], map, { changedFiles: ["src/pages/orders.ts", "api/orders.yaml"] }), ["/source-and-spec", "/spec-only"]);
});

test("a route that joins several operations is linked when any one of their specs changed", () => {
  const map = mapOf(
    [route("/plain"), route("/orders")],
    [operation("listOrders", { [SPEC]: "api/orders.yaml" }), operation("getOrder", { [SPEC]: "api/order-detail.yaml" })],
    [joins("/orders", "listOrders"), joins("/orders", "getOrder")],
  );

  assert.deepEqual(rankRoutesByChange(["/plain", "/orders"], map, { changedFiles: ["api/order-detail.yaml"] }), ["/orders", "/plain"]);
});

test("an operation's spec links the routes that join it and no other route", () => {
  const map = mapOf(
    [route("/a"), route("/b"), route("/c")],
    [operation("listOrders", { [SPEC]: "api/orders.yaml" }), operation("listUsers", { [SPEC]: "api/users.yaml" })],
    [joins("/c", "listOrders"), joins("/a", "listUsers")],
  );

  assert.deepEqual(rankRoutesByChange(["/a", "/b", "/c"], map, { changedFiles: ["api/orders.yaml"] }), ["/c", "/a", "/b"]);
});

test("with nothing to match the order stays the file's, whatever the map declares", () => {
  const nothingDeclared = mapOf(FILE_ORDER.map((path) => route(path)));
  const otherFilesDeclared = mapOf(
    FILE_ORDER.map((path) => route(path, { [SOURCE]: "src/other.ts", [IMPLEMENTATION]: ["src/elsewhere/a.ts"] })),
    [operation("op", { [SPEC]: "api/other.yaml" })],
    [joins("/z", "op")],
  );
  const everythingLinked = mapOf(FILE_ORDER.map((path) => route(path, { [SOURCE]: "src/pages/cart.ts" })));
  const changed = { changedFiles: ["src/pages/cart.ts"] };

  assert.deepEqual(rankRoutesByChange(FILE_ORDER, nothingDeclared, changed), FILE_ORDER, "a map that declares no link field");
  assert.deepEqual(rankRoutesByChange(FILE_ORDER, otherFilesDeclared, changed), FILE_ORDER, "every link field naming a file that did not change");
  assert.deepEqual(rankRoutesByChange(FILE_ORDER, everythingLinked, changed), FILE_ORDER, "every route linked to the same changed file");
  assert.deepEqual(rankRoutesByChange(FILE_ORDER, everythingLinked, { changedFiles: [] }), FILE_ORDER, "no changed file");
  assert.deepEqual(rankRoutesByChange(FILE_ORDER, everythingLinked, { changedFiles: ["", ".", "./", "/"] }), FILE_ORDER, "changed files that name nothing");
  /* One route only: were every route linked alike, a promotion of all of them would leave the order as it was. */
  const lastNamesNothing = mapOf(FILE_ORDER.map((path) => route(path, path === "/a" ? { [SOURCE]: "./", [IMPLEMENTATION]: ["", "."] } : {})));
  assert.deepEqual(rankRoutesByChange(FILE_ORDER, lastNamesNothing, { changedFiles: ["", "./", "src/pages/cart.ts"] }), FILE_ORDER, "a declared path that names nothing is not a changed file that names nothing");
  assert.deepEqual(rankRoutesByChange(FILE_ORDER, undefined, changed), FILE_ORDER, "no map at all");
});

test("a route whose path, name or component only resembles a changed file is not promoted, nor one declared in a file beside it", () => {
  const map = mapOf([
    route("/home"),
    route("/cart", { name: "cart", component: "CartPage" }),
    route("/src/pages/cart"),
    route("/sibling", { [SOURCE]: "src/pages/home.page.ts" }),
  ]);

  const ranked = rankRoutesByChange(["/home", "/cart", "/src/pages/cart", "/sibling"], map, { changedFiles: ["src/pages/cart.page.ts"] });

  assert.deepEqual(ranked, ["/home", "/cart", "/src/pages/cart", "/sibling"]);
});

test("a path the map lists twice ranks by the best of its entries, wherever the bare one stands", () => {
  const linked = route("/dup", { [SOURCE]: "src/pages/cart.ts" });
  for (const [where, entries] of [
    ["after the linked entry", [linked, route("/dup")]],
    ["before the linked entry", [route("/dup"), linked]],
  ] as const) {
    const map = mapOf([route("/first"), ...entries]);
    assert.deepEqual(rankRoutesByChange(["/first", "/dup"], map, { changedFiles: ["src/pages/cart.ts"] }), ["/dup", "/first"], `the bare entry stands ${where}`);
  }
});

test("a path the map lists twice with two different links ranks by the better of them, in either order", () => {
  const bySource = route("/dup", { [SOURCE]: "src/pages/cart.ts" });
  const byImplementation = route("/dup", { [IMPLEMENTATION]: ["src/pages/orders.ts"] });
  for (const entries of [[bySource, byImplementation], [byImplementation, bySource]]) {
    const map = mapOf([route("/by-source", { [SOURCE]: "src/pages/cart.ts" }), ...entries]);
    assert.deepEqual(rankRoutesByChange(["/by-source", "/dup"], map, { changedFiles: ["src/pages/cart.ts", "src/pages/orders.ts"] }), ["/dup", "/by-source"]);
  }
});

test("a route absent from the map is not linked to anything", () => {
  const map = mapOf([route("/known", { [SOURCE]: "src/pages/cart.ts" })]);

  assert.deepEqual(rankRoutesByChange(["/absent", "/known"], map, { changedFiles: ["src/pages/cart.ts"] }), ["/known", "/absent"]);
});

/* ── how a declared path meets a changed file ── */

const SPELLINGS = ["src/pages/cart.ts", "./src/pages/cart.ts", "/src/pages/cart.ts", "src\\pages\\cart.ts", ".\\src\\pages\\cart.ts", "src//pages/./cart.ts"];

test("a path names the same file however it is spelled: separators, a leading dot or slash, doubled or dotted segments", () => {
  for (const spelling of SPELLINGS) {
    const declared = mapOf([route("/other"), route("/cart", { [SOURCE]: spelling })]);
    assert.deepEqual(rankRoutesByChange(["/other", "/cart"], declared, { changedFiles: ["src/pages/cart.ts"] }), ["/cart", "/other"], `declared as ${spelling}`);
    const changed = mapOf([route("/other"), route("/cart", { [SOURCE]: "src/pages/cart.ts" })]);
    assert.deepEqual(rankRoutesByChange(["/other", "/cart"], changed, { changedFiles: [spelling] }), ["/cart", "/other"], `changed as ${spelling}`);
  }
});

test("in a single repo a file at the root names itself, and only itself", () => {
  const linked = mapOf([route("/other"), route("/home", { [SOURCE]: "routes.ts" })]);
  assert.deepEqual(rankRoutesByChange(["/other", "/home"], linked, { changedFiles: ["routes.ts"] }), ["/home", "/other"]);
  assert.deepEqual(rankRoutesByChange(["/other", "/home"], linked, { changedFiles: ["app.ts"] }), ["/other", "/home"]);
});

test("a bare file name is never the suffix that links two paths, whichever of them is the bare one", () => {
  const declaredDeep = mapOf([route("/other"), route("/page", { [SOURCE]: "src/pages/index.ts" })]);
  const declaredBare = mapOf([route("/other"), route("/page", { [SOURCE]: "index.ts" })]);

  assert.deepEqual(rankRoutesByChange(["/other", "/page"], declaredDeep, { changedFiles: ["index.ts"] }), ["/other", "/page"]);
  assert.deepEqual(rankRoutesByChange(["/other", "/page"], declaredBare, { changedFiles: ["src/pages/index.ts"] }), ["/other", "/page"]);
});

test("a path re-rooted under a longer one links when the shorter spans two segments, whichever of them is the longer", () => {
  const declaredLonger = mapOf([route("/other"), route("/page", { [SOURCE]: "web/src/pages/cart.ts" })]);
  const declaredShorter = mapOf([route("/other"), route("/page", { [SOURCE]: "pages/cart.ts" })]);

  assert.deepEqual(rankRoutesByChange(["/other", "/page"], declaredLonger, { changedFiles: ["src/pages/cart.ts"] }), ["/page", "/other"]);
  assert.deepEqual(rankRoutesByChange(["/other", "/page"], declaredShorter, { changedFiles: ["web/src/pages/cart.ts"] }), ["/page", "/other"]);
});

test("a suffix has to start at a segment: the end of a longer name is not the same file", () => {
  const map = mapOf([route("/other"), route("/page", { [SOURCE]: "src/mypages/cart.ts" })]);

  assert.deepEqual(rankRoutesByChange(["/other", "/page"], map, { changedFiles: ["pages/cart.ts"] }), ["/other", "/page"]);
});

/* ── a cross-repo run ── */

const ROOT_FROM_MIRROR = "e2e/.qa/service-context/org__orders-svc";
const ROOT_FROM_E2E_DIR = ".qa/service-context/org__orders-svc";
const STAGED_ROOTS = [ROOT_FROM_MIRROR, ROOT_FROM_E2E_DIR];

/* The service's own changed files are named as its repository names them; the map names them where the snapshot of that service was staged. */
const specJoinedTo = (declared: string): ArchitectureContext =>
  mapOf([route("/other"), route("/orders")], [operation("listOrders", { [SPEC]: declared })], [joins("/orders", "listOrders")]);
const crossRepo = (changedFiles: string[], stagedRoots: string[] = STAGED_ROOTS) => ({ changedFiles, stagedRoots });

test("on a cross-repo run a path under the service's staged root is compared with the service's changed files, whichever way the map names that root", () => {
  for (const root of STAGED_ROOTS) {
    assert.deepEqual(
      rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${root}/contracts/api/orders.yaml`), crossRepo(["api/orders.yaml"])),
      ["/orders", "/other"],
      `a suffix of the path under ${root}`,
    );
    assert.deepEqual(
      rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${root}/api/orders.yaml`), crossRepo(["api/orders.yaml"])),
      ["/orders", "/other"],
      `the whole path under ${root}`,
    );
    assert.deepEqual(
      rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${root}/api/orders.yaml`), crossRepo(["services/orders/api/orders.yaml"])),
      ["/orders", "/other"],
      `a changed path that is the longer one, under ${root}`,
    );
  }
});

test("a staged root is read like any other path: separators, a leading dot and a trailing slash do not matter", () => {
  const roots = [".\\e2e\\.qa\\service-context\\org__orders-svc\\"];

  assert.deepEqual(
    rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${ROOT_FROM_MIRROR}/api/orders.yaml`), crossRepo(["api/orders.yaml"], roots)),
    ["/orders", "/other"],
  );
});

test("on a cross-repo run a path outside the staged root is never compared, however well it matches", () => {
  const map = mapOf(
    [route("/other"), route("/by-source", { [SOURCE]: "src/pages/orders.ts" }), route("/by-implementation", { [IMPLEMENTATION]: ["src/pages/orders.ts"] }), route("/orders")],
    [operation("listOrders", { [SPEC]: "api/orders.yaml" })],
    [joins("/orders", "listOrders")],
  );
  const routes = ["/other", "/by-source", "/by-implementation", "/orders"];
  const changedFiles = ["src/pages/orders.ts", "api/orders.yaml"];

  assert.deepEqual(rankRoutesByChange(routes, map, crossRepo(changedFiles)), routes, "primary-repo paths never match the service's files");
  assert.notDeepEqual(rankRoutesByChange(routes, map, { changedFiles }), routes, "the same map and files on a single-repo run do match");
});

test("on a cross-repo run a match of one path segment is no match, by equality or by suffix", () => {
  assert.deepEqual(
    rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${ROOT_FROM_MIRROR}/routes.ts`), crossRepo(["routes.ts"])),
    ["/other", "/orders"],
    "equality of a root-level file",
  );
  assert.deepEqual(
    rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${ROOT_FROM_MIRROR}/contracts/openapi.yaml`), crossRepo(["openapi.yaml"])),
    ["/other", "/orders"],
    "a bare file name as the suffix",
  );
  assert.deepEqual(
    rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${ROOT_FROM_MIRROR}/openapi.yaml`), crossRepo(["contracts/openapi.yaml"])),
    ["/other", "/orders"],
    "a bare file name as the longer path's suffix, the other way round",
  );
});

test("on a cross-repo run only the spec of a joined operation links a route: its own files and its declaring source belong to the other repo, whatever their path", () => {
  const underRoot = (path: string): string => `${ROOT_FROM_MIRROR}/${path}`;
  const map = mapOf(
    [
      route("/other"),
      route("/by-implementation", { [IMPLEMENTATION]: [underRoot("changed/src/pages/orders.ts")] }),
      route("/by-source", { [SOURCE]: underRoot("changed/src/pages/orders.ts") }),
      route("/by-spec"),
    ],
    [operation("listOrders", { [SPEC]: underRoot("contracts/api/orders.yaml") })],
    [joins("/by-spec", "listOrders")],
  );
  const routes = ["/other", "/by-implementation", "/by-source", "/by-spec"];
  const changedFiles = ["src/pages/orders.ts", "api/orders.yaml"];

  assert.deepEqual(rankRoutesByChange(routes, map, crossRepo(changedFiles)), ["/by-spec", "/other", "/by-implementation", "/by-source"]);
  assert.deepEqual(rankRoutesByChange(routes, map, { changedFiles }), ["/by-implementation", "/by-source", "/by-spec", "/other"], "the same map and files on a single repo link all three");
});

test("a service name the map declares links nothing: only declared paths count", () => {
  const map = mapOf([route("/other"), route("/orders")], [operation("listOrders", { service: "orders-svc" })], [joins("/orders", "listOrders")]);
  const changedFiles = ["services/orders-svc/api/orders.yaml"];

  assert.deepEqual(rankRoutesByChange(["/other", "/orders"], map, crossRepo(changedFiles)), ["/other", "/orders"], "cross-repo");
  assert.deepEqual(rankRoutesByChange(["/other", "/orders"], map, { changedFiles }), ["/other", "/orders"], "single repo");
});

test("a cross-repo run whose staged root no path of the map can be under attributes nothing", () => {
  assert.deepEqual(
    rankRoutesByChange(["/other", "/orders"], specJoinedTo("api/orders.yaml"), crossRepo(["api/orders.yaml"], [])),
    ["/other", "/orders"],
  );
});

test("a path that only starts like the staged root is not under it", () => {
  assert.deepEqual(
    rankRoutesByChange(["/other", "/orders"], specJoinedTo(`${ROOT_FROM_MIRROR}-other/api/orders.yaml`), crossRepo(["api/orders.yaml"])),
    ["/other", "/orders"],
  );
});

/* ── a map that does not hold to its own shape ── */

test("a malformed link field is skipped, never thrown on, and the fields that are valid still rank", () => {
  const map = mapOf(
    [
      route("/string-list", { [IMPLEMENTATION]: "src/pages/cart.ts" }),
      route("/mixed-list", { [IMPLEMENTATION]: ["src/pages/cart.ts", 3] }),
      route("/object-list", { [IMPLEMENTATION]: { 0: "src/pages/cart.ts" } }),
      route("/number-source", { [SOURCE]: 42 }),
      route("/null-source", { [SOURCE]: null }),
      route("/array-source", { [SOURCE]: ["src/pages/cart.ts"] }),
      route("/spec-list"),
      route("/spec-number"),
      route("/dangling"),
      null,
      undefined,
      "not a route",
      route("/valid", { [SOURCE]: "src/pages/cart.ts" }),
    ],
    [
      operation("bySpecList", { [SPEC]: ["src/pages/cart.ts"] }),
      operation("bySpecNumber", { [SPEC]: 7 }),
      { method: "GET", path: "/nameless", [SPEC]: "src/pages/cart.ts" },
      null,
      undefined,
      "not an operation",
    ],
    [joins("/spec-list", "bySpecList"), joins("/spec-number", "bySpecNumber"), joins("/dangling", "missing"), null, undefined, "not a link", { route: 5 }, { route: "/dangling" }],
  );
  const routes = ["/string-list", "/mixed-list", "/object-list", "/number-source", "/null-source", "/array-source", "/spec-list", "/spec-number", "/dangling", "/valid"];

  const ranked = rankRoutesByChange(routes, map, { changedFiles: ["src/pages/cart.ts"] });

  assert.deepEqual(ranked, ["/valid", ...routes.slice(0, -1)]);
});

test("a changed file or a staged root that is not text is skipped, never thrown on, and the valid ones still count", () => {
  const notText = [3, null, undefined, { path: "src/pages/cart.ts" }, ["src/pages/cart.ts"]] as unknown as string[];
  const map = mapOf([route("/other"), route("/page", { [SOURCE]: "src/pages/cart.ts" })]);
  assert.deepEqual(rankRoutesByChange(["/other", "/page"], map, { changedFiles: [...notText, "src/pages/cart.ts"] }), ["/page", "/other"], "a valid file among the others");
  assert.deepEqual(rankRoutesByChange(["/other", "/page"], map, { changedFiles: notText }), ["/other", "/page"], "nothing valid to match");

  const spec = specJoinedTo(`${ROOT_FROM_MIRROR}/api/orders.yaml`);
  const crossRepoWith = (stagedRoots: unknown[]) => ({ changedFiles: ["api/orders.yaml"], stagedRoots: stagedRoots as string[] });
  assert.deepEqual(rankRoutesByChange(["/other", "/orders"], spec, crossRepoWith([5, null, ROOT_FROM_MIRROR])), ["/orders", "/other"], "a valid root among the others");
  assert.deepEqual(rankRoutesByChange(["/other", "/orders"], spec, crossRepoWith([5, null])), ["/other", "/orders"], "no valid root: still a cross-repo run, with nothing to attribute");
});

test("a map whose sections are not lists ranks nothing and throws nothing", () => {
  for (const [name, map] of [
    ["routes", mapOf("nope", [], [])],
    ["api", mapOf([route("/a", { [SOURCE]: "src/pages/cart.ts" })], { not: "a list" }, [])],
    ["feBe", mapOf([route("/b")], [operation("op", { [SPEC]: "src/pages/cart.ts" })], 3)],
    ["all", mapOf(null, null, null)],
  ] as const) {
    assert.doesNotThrow(() => rankRoutesByChange(["/a", "/b"], map, { changedFiles: ["src/pages/cart.ts"] }), name);
  }
  assert.deepEqual(rankRoutesByChange(["/b", "/a"], mapOf("nope"), { changedFiles: ["src/pages/cart.ts"] }), ["/b", "/a"]);
  assert.deepEqual(
    rankRoutesByChange(["/b", "/a"], mapOf([route("/b"), route("/a", { [SOURCE]: "src/pages/cart.ts" })], { not: "a list" }), { changedFiles: ["src/pages/cart.ts"] }),
    ["/a", "/b"],
    "the sections that hold are still read when another does not",
  );
});

test("ranking leaves the list it was given as it was", () => {
  const given = Object.freeze([...FILE_ORDER]);
  const map = mapOf(FILE_ORDER.map((path) => route(path, path === "/a" ? { [SOURCE]: "src/pages/cart.ts" } : {})));

  const ranked = rankRoutesByChange(given, map, { changedFiles: ["src/pages/cart.ts"] });

  assert.deepEqual(ranked, ["/a", "/m", "/z", "/b", "/y"]);
  assert.deepEqual(given, FILE_ORDER);
});
