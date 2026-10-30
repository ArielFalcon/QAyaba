import { test } from "node:test";
import assert from "node:assert/strict";
import { PRINTED_ROUTE_SOURCE, printedRoute } from "@kernel/printed-route.ts";
import { availabilityLine } from "@contexts/generation/domain/route-availability-section.ts";
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";

test("a page is printed by its address, and by the template it was opened from when it has one", () => {
  assert.equal(printedRoute({ route: "/shops" }), "/shops");
  assert.equal(printedRoute({ route: "/shops/madrid", template: "/shops/:city" }), "/shops/madrid (instance of /shops/:city)");
});

test("each part of a printed page can be rendered by the caller", () => {
  assert.equal(printedRoute({ route: "/shops/madrid", template: "/shops/:city" }, (part) => `\`${part}\``), "`/shops/madrid` (instance of `/shops/:city`)");
});

test("a printed page is read back as its address and its template", () => {
  const read = new RegExp(`^${PRINTED_ROUTE_SOURCE}$`);
  assert.deepEqual(read.exec("/shops/madrid (instance of /shops/:city)")?.slice(1, 3), ["/shops/madrid", "/shops/:city"]);
  assert.deepEqual(read.exec("/shops")?.slice(1, 3), ["/shops", undefined]);
});

test("the route availability line names a template page the way every other section does", () => {
  const fact = { route: "/shops/madrid", template: "/shops/:city", outcome: { kind: "status", status: 404 }, basis: { kind: "unexplained", links: [] } } as unknown as RouteAvailabilityFact;
  assert.ok(availabilityLine(fact).startsWith(`- ${printedRoute(fact)}: `));
});
