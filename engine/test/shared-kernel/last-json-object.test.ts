import { test } from "node:test";
import assert from "node:assert/strict";
import { closingJsonObject } from "@kernel/last-json-object.ts";

test("the object that closes the text is the answer, whatever objects came before it", () => {
  const text = 'first {"specs":["a.spec.ts"]} then {"status":"old"} and finally {"status":"completed","n":{"deep":1}}';
  assert.deepEqual(closingJsonObject(text), { status: "completed", n: { deep: 1 } });
});

test("braces in the narration that are not JSON never hide the closing object, nor does a closing fence", () => {
  const text = [
    "I read `{name, value, url}` from the capture and wrote `async ({ page }) => {` in the test.",
    "```json",
    '{"status":"completed","summary":"a } inside a string and a \\" quote"}',
    "```",
  ].join("\n");
  assert.equal(closingJsonObject(text)?.summary, 'a } inside a string and a " quote');
});

test("an unbalanced opening brace before the object does not swallow it", () => {
  assert.deepEqual(closingJsonObject('the callback opens { and never closes. {"status":"ok"}'), { status: "ok" });
});

test("a closing block that does not read leaves no answer, never an earlier object", () => {
  assert.equal(closingJsonObject("no json at all"), undefined);
  assert.equal(closingJsonObject('{"status":"draft"} then {"status":"final",}'), undefined, "not JSON");
  assert.equal(closingJsonObject('{"status":"draft"} then {"status":"fin'), undefined, "cut short");
  assert.equal(closingJsonObject('{"status":"draft"} and my helper is `async ({ page }) => {`'), undefined, "a brace after the answer");
});

test("an object after the answer closes the text instead of it", () => {
  assert.deepEqual(closingJsonObject('{"status":"completed"}\n{"note":"a quoted payload"}'), { note: "a quoted payload" });
});

test("an array is not an object, and the nested objects of the closing one are not answers of their own", () => {
  assert.deepEqual(closingJsonObject('x {"a":1} y [1,2] {"b":{"c":2}}'), { b: { c: 2 } });
});
