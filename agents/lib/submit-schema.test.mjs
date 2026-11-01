import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { argsShapeOf } from "./submit-schema.mjs";

const accepts = (schema, value) => z.object(argsShapeOf(z, schema)).safeParse(value).success;

test("a property is required unless the schema leaves it out of required", () => {
  const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "boolean" } }, required: ["a"] };
  assert.equal(accepts(schema, { a: "x" }), true);
  assert.equal(accepts(schema, { b: true }), false);
  assert.equal(accepts(schema, { a: 1 }), false);
});

test("an enum, a union and a nullable keep exactly the values the schema lists", () => {
  const schema = {
    type: "object",
    properties: {
      severity: { type: "string", enum: ["blocking", "advisory"] },
      citation: { anyOf: [{ type: "object", properties: { ref: { type: "string" } }, required: ["ref"] }, { type: "null" }] },
    },
    required: ["severity", "citation"],
  };
  assert.equal(accepts(schema, { severity: "blocking", citation: null }), true);
  assert.equal(accepts(schema, { severity: "advisory", citation: { ref: "a.spec.ts" } }), true);
  assert.equal(accepts(schema, { severity: "nit", citation: null }), false);
  assert.equal(accepts(schema, { severity: "blocking", citation: { ref: 1 } }), false);
});

test("array items, string minimum length and number bounds are enforced", () => {
  const schema = {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string", minLength: 1 } },
      n: { type: "integer", minimum: 1, maximum: 3 },
      share: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["files", "n", "share"],
  };
  assert.equal(accepts(schema, { files: ["a"], n: 3, share: 0.5 }), true);
  assert.equal(accepts(schema, { files: [""], n: 3, share: 0.5 }), false);
  assert.equal(accepts(schema, { files: ["a"], n: 4, share: 0.5 }), false);
  assert.equal(accepts(schema, { files: ["a"], n: 1.5, share: 0.5 }), false);
  assert.equal(accepts(schema, { files: ["a"], n: 1, share: 0 }), false);
});

test("a description of the schema is the description the model reads", () => {
  const shape = argsShapeOf(z, { type: "object", properties: { a: { type: "string", description: "what a is" } }, required: ["a"] });
  assert.equal(z.toJSONSchema(z.object(shape)).properties.a.description, "what a is");
});

test("a keyword or a type the converter does not know breaks it instead of loosening the tool", () => {
  assert.throws(() => argsShapeOf(z, { type: "object", properties: { a: { type: "string", pattern: "^x" } } }), /unsupported keyword "pattern"/);
  assert.throws(() => argsShapeOf(z, { type: "object", properties: { a: { $ref: "#/definitions/a" } } }), /no supported type/);
  assert.throws(() => argsShapeOf(z, { type: "array" }), /arguments are an object/);
});

test("every committed submit contract converts, and keeps the property names of its schema", () => {
  const contracts = JSON.parse(readFileSync(new URL("./submit-contracts.json", import.meta.url), "utf8"));
  const tools = Object.keys(contracts);
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(argsShapeOf(z, contracts[tool])), Object.keys(contracts[tool].properties), tool);
  }
});
