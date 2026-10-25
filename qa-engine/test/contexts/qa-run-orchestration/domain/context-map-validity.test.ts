import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMapValidity, parseNameStatusZ } from "../../../../src/contexts/qa-run-orchestration/domain/context-map-validity.ts";

const map = {
  routes: [{ source: "src/app/shops.routes.ts", implementationFiles: ["src/app/shops/shops.page.html"] }],
  api: [{ spec: "contracts/api.yaml" }],
};

test("the same sha is valid without looking at changes", () => {
  assert.deepEqual(contextMapValidity(map, "a", "a", undefined), { valid: true, reason: "same-sha" });
});

test("a map is valid at another sha when no file it names changed", () => {
  const v = contextMapValidity(map, "a", "b", [{ status: "M", path: "src/app/other.ts" }, { status: "A", path: "README.md" }]);
  assert.deepEqual(v, { valid: true, reason: "inputs-unchanged" });
});

test("a modified or deleted named file invalidates the map", () => {
  for (const status of ["M", "D"]) {
    assert.deepEqual(contextMapValidity(map, "a", "b", [{ status, path: "src/app/shops/shops.page.html" }]), { valid: false, reason: "inputs-changed" });
  }
  assert.deepEqual(contextMapValidity(map, "a", "b", [{ status: "M", path: "./contracts/api.yaml" }]), { valid: false, reason: "inputs-changed" });
});

test("a new file of the same kind as a route source invalidates the map, a new file of another kind does not", () => {
  assert.equal(contextMapValidity(map, "a", "b", [{ status: "A", path: "src/app/cart/cart.routes.ts" }]).valid, false);
  assert.equal(contextMapValidity(map, "a", "b", [{ status: "A", path: "src/app/cart/cart.page.ts" }]).valid, true);
  assert.equal(contextMapValidity(map, "a", "b", [{ status: "M", path: "src/app/cart/cart.routes.ts" }]).valid, true, "a changed file the map does not name is not an input");
});

test("changes that could not be read leave the map unverifiable", () => {
  assert.deepEqual(contextMapValidity(map, "a", "b", undefined), { valid: false, reason: "unverifiable" });
});

test("name-status output is parsed in order", () => {
  assert.deepEqual(parseNameStatusZ("M\0a.ts\0A\0dir/b c.ts\0"), [{ status: "M", path: "a.ts" }, { status: "A", path: "dir/b c.ts" }]);
  assert.deepEqual(parseNameStatusZ(""), []);
});
