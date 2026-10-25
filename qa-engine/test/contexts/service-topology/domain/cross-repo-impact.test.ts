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
