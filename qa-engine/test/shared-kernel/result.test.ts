import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, err, isOk, map, type Result } from "@kernel/result.ts";

test("ok carries a value and is recognized by isOk", () => {
  const r: Result<number, string> = ok(42);
  assert.equal(isOk(r), true);
  if (isOk(r)) assert.equal(r.value, 42);
});

test("err carries an error and is not ok", () => {
  const r: Result<number, string> = err("boom");
  assert.equal(isOk(r), false);
  if (!r.ok) assert.equal(r.error, "boom");
});

test("map transforms ok, passes err through untouched", () => {
  assert.deepEqual(map(ok(2), (n) => n * 10), ok(20));
  assert.deepEqual(map(err<number, string>("e"), (n) => n * 10), err("e"));
});
