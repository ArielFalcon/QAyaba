import { test } from "node:test";
import assert from "node:assert/strict";
import { dataStateRouteFor } from "@contexts/generation/domain/data-state-route.ts";

const routes = {
  "/shops": "list",
  "/shops/:province/:city": "city list",
  "/shops/*": "any shop page",
};

test("a pathname takes its exact key, then a key with parameters it fills, then a prefix", () => {
  assert.equal(dataStateRouteFor(routes, "/shops"), "list");
  assert.equal(dataStateRouteFor(routes, "/shops/madrid/alcala"), "city list");
  assert.equal(dataStateRouteFor(routes, "/shops/madrid/alcala/casa-pepe"), "any shop page");
  assert.equal(dataStateRouteFor(routes, "/home"), undefined);
});

test("a key with parameters matches only the pages that fill every segment", () => {
  const only = { "/shops/:province/:city": "city list" };
  assert.equal(dataStateRouteFor(only, "/shops/madrid"), undefined);
  assert.equal(dataStateRouteFor(only, "/shops/madrid/alcala/casa-pepe"), undefined);
  assert.equal(dataStateRouteFor(only, "/stores/madrid/alcala"), undefined);
  assert.equal(dataStateRouteFor(only, "/shops/madrid/alcala/"), "city list");
});
