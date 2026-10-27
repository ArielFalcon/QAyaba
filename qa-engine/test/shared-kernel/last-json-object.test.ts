import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonObjectsIn, lastJsonObjectWhere } from "@kernel/last-json-object.ts";

const hasStatus = (o: Record<string, unknown>): boolean => typeof o.status === "string";

test("the last object that satisfies the predicate wins, whatever objects came before it", () => {
  const text = 'first {"specs":["a.spec.ts"]} then {"status":"old"} and finally {"status":"completed","n":{"deep":1}}';
  assert.deepEqual(lastJsonObjectWhere(text, hasStatus), { status: "completed", n: { deep: 1 } });
});

test("braces in the narration that are not JSON never hide the closing object", () => {
  const text = [
    "I read `{name, value, url}` from the capture and wrote `async ({ page }) => {` in the test.",
    "```json",
    '{"status":"completed","summary":"a } inside a string and a \\" quote"}',
    "```",
  ].join("\n");
  assert.equal(lastJsonObjectWhere(text, hasStatus)?.summary, 'a } inside a string and a " quote');
});

test("an unbalanced opening brace before the object does not swallow it", () => {
  assert.deepEqual(lastJsonObjectWhere('the callback opens { and never closes. {"status":"ok"}', hasStatus), { status: "ok" });
});

test("text with no object satisfying the predicate reads as nothing, never as a partial object", () => {
  assert.equal(lastJsonObjectWhere("no json at all", hasStatus), undefined);
  assert.equal(lastJsonObjectWhere('{"other":1} {"truncated":', hasStatus), undefined);
  assert.equal(lastJsonObjectWhere('[{"status":"in an array"}]', (o) => o.status === "nope"), undefined);
});

test("every top-level object is listed in document order and arrays are not objects", () => {
  assert.deepEqual(jsonObjectsIn('x {"a":1} y [1,2] {"b":{"c":2}} {not json}'), [{ a: 1 }, { b: { c: 2 } }]);
});
