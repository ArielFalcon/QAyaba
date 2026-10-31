/* An operation's pattern matches the paths it answers, with a parameter value and with a gateway prefix, and not a sibling resource. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_OPERATION_PATTERN_CHARS, operationUrlPattern, requestServesOperation } from "@contexts/service-topology/domain/operation-url-pattern.ts";

test("a parameter takes one segment of any value, in either spelling", () => {
  assert.equal(requestServesOperation("/owners/42/pets", { path: "/owners/{ownerId}/pets" }), true);
  assert.equal(requestServesOperation("/owners/ana-lopez/pets/", { path: "/owners/:id/pets" }), true);
  assert.equal(requestServesOperation("/owners/42/pets/7", { path: "/owners/{ownerId}/pets" }), false);
});

test("a gateway prefix before the path is tolerated", () => {
  assert.equal(requestServesOperation("/api/orders", { path: "/orders" }), true);
  assert.equal(requestServesOperation("/svc/api/v1/orders/9", { path: "/orders/{id}" }), true);
});

test("a sibling resource is not served", () => {
  assert.equal(requestServesOperation("/orders/7/items", { path: "/items" }), false);
  assert.equal(requestServesOperation("/orders/0f8fad5b-d9cb-469f-a165-70867728950e/items", { path: "/items" }), false);
  assert.equal(requestServesOperation("/invoices/7", { path: "/orders/{id}" }), false);
  assert.equal(requestServesOperation("/orders/7", { path: "/items/{id}" }), false);
});

test("regular expression characters in a literal segment match themselves", () => {
  assert.equal(requestServesOperation("/v1.0/items", { path: "/v1.0/items" }), true);
  assert.equal(requestServesOperation("/v1x0/items", { path: "/v1.0/items" }), false);
});

test("an operation with no literal segment, or a pattern past its bound, answers nothing", () => {
  assert.equal(operationUrlPattern({ path: "/{id}" }), undefined);
  assert.equal(operationUrlPattern({ path: "/" }), undefined);
  assert.equal(operationUrlPattern({ path: `/${"a".repeat(MAX_OPERATION_PATTERN_CHARS)}` }), undefined);
  assert.equal(requestServesOperation("/anything", { path: "/{id}" }), false);
});
