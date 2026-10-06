import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTE_REASON, classifyRoute, partitionRoutes, type RouteReason } from "@kernel/route-capturability.ts";

const CAPTURABLE: ReadonlyArray<[string, string]> = [
  ["the root", "/"],
  ["a plain path", "/cart"],
  ["a nested path with a trailing slash", "/a/b/c/"],
  ["a numeric segment", "/orders/42"],
  ["a colon inside a segment", "/files/report:2024"],
  ["a colon after a name", "/a:b"],
  ["a query", "/search?q=1"],
  ["a hash route", "/#/orders"],
  ["a hash route with no leading slash", "#/orders"],
  ["path characters beyond ascii", "/café/menú"],
  ["dots, dashes, underscores and tildes", "/a.b-c_d~e"],
  ["a path with no leading slash", "orders"],
];

for (const [label, route] of CAPTURABLE) {
  test(`${label} is a route the browser can open as written`, () => {
    assert.deepEqual(classifyRoute(route), { capturable: true });
  });
}

const UNCAPTURABLE: ReadonlyArray<[string, string, RouteReason]> = [
  ["a segment that is a parameter", "/:id", ROUTE_REASON.TEMPLATE],
  ["a parameter in the middle of a path", "/product/:id/view", ROUTE_REASON.TEMPLATE],
  ["an optional parameter", "/users/:id?", ROUTE_REASON.TEMPLATE],
  ["a parameter with no leading slash", ":id/edit", ROUTE_REASON.TEMPLATE],
  ["a parameter in a hash route", "#/product/:id", ROUTE_REASON.TEMPLATE],
  ["a brace parameter", "/users/{id}", ROUTE_REASON.TEMPLATE],
  ["a brace parameter before more path", "/users/{id}/posts", ROUTE_REASON.TEMPLATE],
  ["a bracket parameter", "/blog/[slug]", ROUTE_REASON.TEMPLATE],
  ["a bracket catch-all", "/docs/[...rest]", ROUTE_REASON.TEMPLATE],
  ["a wildcard", "*", ROUTE_REASON.TEMPLATE],
  ["a wildcard after a path", "/files/*", ROUTE_REASON.TEMPLATE],
  ["words about a page", "the cart page", ROUTE_REASON.FREE_TEXT],
  ["a path with a space", "/cart page", ROUTE_REASON.FREE_TEXT],
  ["a path with a tab", "/a\tb", ROUTE_REASON.FREE_TEXT],
  ["a backslash, which a browser reads as a slash", "/\\evil.example", ROUTE_REASON.FREE_TEXT],
  ["an absolute address", "https://app.example/a", ROUTE_REASON.ABSOLUTE_URL],
  ["an absolute address in capitals", "HTTP://app.example/a", ROUTE_REASON.ABSOLUTE_URL],
  ["a protocol-relative address", "//evil.example/x", ROUTE_REASON.ABSOLUTE_URL],
  ["a protocol-relative host alone", "//evil.example", ROUTE_REASON.ABSOLUTE_URL],
  ["a script address", "javascript:alert(1)", ROUTE_REASON.ABSOLUTE_URL],
  ["a scheme that is not http", "ftp://files.example/x", ROUTE_REASON.ABSOLUTE_URL],
  ["an address that names a scheme and no slashes", "mailto:a@b.example", ROUTE_REASON.ABSOLUTE_URL],
  ["an interpolation", "/orders/${id}", ROUTE_REASON.INTERPOLATION],
  ["an interpolation inside a template literal", "`/orders/${id}`", ROUTE_REASON.INTERPOLATION],
  ["nothing", "", ROUTE_REASON.EMPTY],
  ["only blanks", "   ", ROUTE_REASON.EMPTY],
];

for (const [label, route, reason] of UNCAPTURABLE) {
  test(`${label} is not a route the browser can open as written`, () => {
    assert.deepEqual(classifyRoute(route), { capturable: false, reason });
  });
}

test("a route is judged on its trimmed text", () => {
  assert.deepEqual(classifyRoute("  /cart  "), { capturable: true });
  assert.deepEqual(classifyRoute("  /product/:id  "), { capturable: false, reason: ROUTE_REASON.TEMPLATE });
});

test("a route is classified the same however many times it is asked", () => {
  for (const [, route] of [...CAPTURABLE, ...UNCAPTURABLE]) {
    const first = classifyRoute(route);
    assert.deepEqual(classifyRoute(route), first);
    assert.deepEqual(classifyRoute(route), first);
  }
});

test("partitioning keeps the capturable routes in order, trimmed and once each", () => {
  const { capturable } = partitionRoutes([" /b ", "/a", "/b", "/product/:id", "/a", "/c"]);
  assert.deepEqual(capturable, ["/b", "/a", "/c"]);
});

test("partitioning reports each route it cannot capture once, with its reason, in order", () => {
  const { capturable, uncapturable } = partitionRoutes(["/product/:id/view", "/a", "https://app.example/x", "/product/:id/view", "//evil.example", "/b"]);
  assert.deepEqual(capturable, ["/a", "/b"]);
  assert.deepEqual(uncapturable, [
    { route: "/product/:id/view", reason: ROUTE_REASON.TEMPLATE },
    { route: "https://app.example/x", reason: ROUTE_REASON.ABSOLUTE_URL },
    { route: "//evil.example", reason: ROUTE_REASON.ABSOLUTE_URL },
  ]);
});

test("partitioning drops an empty entry from both lists: nothing was asked for", () => {
  const { capturable, uncapturable } = partitionRoutes(["", "  ", "/a"]);
  assert.deepEqual(capturable, ["/a"]);
  assert.deepEqual(uncapturable, []);
});

test("partitioning an empty list gives two empty lists and leaves its input alone", () => {
  assert.deepEqual(partitionRoutes([]), { capturable: [], uncapturable: [] });
  const input = [" /a ", "/:id"];
  partitionRoutes(input);
  assert.deepEqual(input, [" /a ", "/:id"]);
});
