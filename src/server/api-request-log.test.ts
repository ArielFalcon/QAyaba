import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldLogApiRequest } from "./api-request-log";

test("a successful read (health check, run polling) is not logged", () => {
  assert.equal(shouldLogApiRequest("GET", 200), false);
  assert.equal(shouldLogApiRequest("HEAD", 204), false);
});

test("a failed read is logged", () => {
  assert.equal(shouldLogApiRequest("GET", 404), true);
  assert.equal(shouldLogApiRequest("GET", 500), true);
});

test("a request that changes state is logged whatever the outcome", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(shouldLogApiRequest(method, 200), true);
    assert.equal(shouldLogApiRequest(method, 409), true);
  }
  assert.equal(shouldLogApiRequest(undefined, 200), true);
});
