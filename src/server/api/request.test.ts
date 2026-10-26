import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { z } from "zod";
import { ApiError } from "./api-error";
import { fieldsOf, JsonFieldsSchema, parseJsonBody, withIssues } from "./request";

function bodyOf(text: string): any {
  return Readable.from([text]);
}

const Named = z.object({ name: z.string("'name' is required") });

async function failureOf(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof ApiError);
    return err;
  }
  assert.fail("expected the body to be refused");
}

test("a body that is not JSON answers 400 'invalid JSON'", async () => {
  const err = await failureOf(parseJsonBody(bodyOf("{nope"), Named));
  assert.equal(err.status, 400);
  assert.equal(err.message, "invalid JSON");
});

test("a blank body is invalid unless the route takes it as empty", async () => {
  assert.equal((await failureOf(parseJsonBody(bodyOf(""), Named))).message, "invalid JSON");
  assert.deepEqual(await parseJsonBody(bodyOf("  "), z.object({}), { optional: true }), {});
});

test("a body over the size cap answers 400 'invalid JSON'", async () => {
  const err = await failureOf(parseJsonBody(bodyOf(JSON.stringify({ name: "x".repeat(100_001) })), Named));
  assert.equal(err.status, 400);
  assert.equal(err.message, "invalid JSON");
});

test("a body the schema rejects answers 400 with the issue messages", async () => {
  const err = await failureOf(parseJsonBody(bodyOf("{}"), Named));
  assert.equal(err.status, 400);
  assert.equal(err.message, "'name' is required");
});

test("a route can name the label and carry the schema's issues beside it", async () => {
  const err = await failureOf(parseJsonBody(bodyOf("{}"), Named, { invalid: withIssues("invalid input"), bare: true }));
  assert.equal(err.message, "invalid input");
  assert.equal(err.bare, true);
  assert.ok(Array.isArray(err.extra.issues));
});

test("a valid body reaches the route typed by its schema", async () => {
  assert.deepEqual(await parseJsonBody(bodyOf('{"name":"demo"}'), Named), { name: "demo" });
});

test("a body that is not an object has no fields for a lenient route to read", async () => {
  assert.deepEqual(await parseJsonBody(bodyOf("null"), JsonFieldsSchema), {});
  assert.deepEqual(await parseJsonBody(bodyOf("[1]"), JsonFieldsSchema), {});
  assert.deepEqual(fieldsOf({ a: 1 }), { a: 1 });
});
