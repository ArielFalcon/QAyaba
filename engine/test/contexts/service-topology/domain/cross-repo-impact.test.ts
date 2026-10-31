/* A handler's route serves a contract operation when verb and path agree, parameters matching parameters and a prefix the
   deployment adds on one side only tolerated. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeServesOperation } from "@contexts/service-topology/domain/cross-repo-impact.ts";

test("the same verb and path, any parameter name or spelling, serves the operation", () => {
  assert.equal(routeServesOperation({ method: "get", path: "/owners/{ownerId}/pets" }, { verb: "GET", path: "/owners/{id}/pets/" }), true);
  assert.equal(routeServesOperation({ method: "GET", path: "/owners/:id" }, { verb: "GET", path: "/owners/{ownerId}" }), true);
});

test("a prefix on one side only is tolerated", () => {
  assert.equal(routeServesOperation({ method: "POST", path: "/orders" }, { verb: "POST", path: "/api/orders" }), true);
  assert.equal(routeServesOperation({ method: "POST", path: "/svc/api/orders" }, { verb: "POST", path: "/api/orders" }), true);
});

test("another verb, another path, or a shorter side made only of parameters serves nothing", () => {
  assert.equal(routeServesOperation({ method: "PUT", path: "/orders" }, { verb: "POST", path: "/orders" }), false);
  assert.equal(routeServesOperation({ method: "GET", path: "/orders/{id}" }, { verb: "GET", path: "/invoices/{id}" }), false);
  assert.equal(routeServesOperation({ method: "GET", path: "/{id}" }, { verb: "GET", path: "/orders/{id}" }), false);
  assert.equal(routeServesOperation({ method: "GET", path: "/" }, { verb: "GET", path: "/orders" }), false);
});

test("a handler that takes any verb serves the operation of every verb on its path", () => {
  for (const method of ["ANY", "all", "*"]) {
    assert.equal(routeServesOperation({ method, path: "/orders/{id}" }, { verb: "DELETE", path: "/orders/{orderId}" }), true);
  }
  assert.equal(routeServesOperation({ method: "ANY", path: "/orders" }, { verb: "GET", path: "/invoices" }), false, "the path still has to agree");
});

test("a path parameter before the matching tail is a different resource, not a base path", () => {
  assert.equal(routeServesOperation({ method: "GET", path: "/items" }, { verb: "GET", path: "/orders/{id}/items" }), false);
  assert.equal(routeServesOperation({ method: "GET", path: "/orders/{id}/items" }, { verb: "GET", path: "/items" }), false);
});

test("a literal base path and a parameterised tail still match", () => {
  assert.equal(routeServesOperation({ method: "GET", path: "/items" }, { verb: "GET", path: "/api/v1/items" }), true);
  assert.equal(routeServesOperation({ method: "GET", path: "/orders/{id}/items" }, { verb: "GET", path: "/api/orders/{orderId}/items" }), true);
});
