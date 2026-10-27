/* The fields an OpenAPI document declares for the items an operation's successful JSON response returns. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { responseItemFields } from "@contexts/service-topology/domain/response-fields.ts";

const doc = (yaml: string): unknown => parse(yaml);
const fieldsOf = (d: unknown, path: string, method = "GET"): string[] | undefined => {
  const fields = responseItemFields(d, method, path);
  return fields === undefined ? undefined : [...fields].sort();
};

const SPEC = doc(`
openapi: 3.0.0
paths:
  /items:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Item"
  /items/by-region/{code}:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  total: { type: integer }
                  results:
                    type: array
                    items:
                      allOf:
                        - $ref: "#/components/schemas/Base"
                        - type: object
                          properties:
                            category: { type: string }
  /items/{id}:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Base"
    delete:
      responses:
        "204": { description: gone }
components:
  schemas:
    Base:
      type: object
      properties:
        id: { type: string }
        name: { type: string, description: a name }
    Item:
      allOf:
        - $ref: "#/components/schemas/Base"
        - type: object
          properties:
            price: { type: number }
            parent:
              $ref: "#/components/schemas/Item"
`);

test("the fields of the items a list operation returns are those of the schema its array holds, references and allOf resolved", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items"), ["id", "name", "parent", "price"]);
});

test("a wrapper object's array of objects is the items, and the wrapper's own fields are not", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items/by-region/ES"), ["category", "id", "name"]);
});

test("an operation that answers one object declares that object's fields", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items/17"), ["id", "name"]);
});

test("of the operations a path could belong to, the one with the most literal segments is chosen", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items/by-region/ES"), ["category", "id", "name"]);
});

test("a gateway prefix before the documented path does not hide the operation", () => {
  assert.deepEqual(fieldsOf(SPEC, "/api/items"), ["id", "name", "parent", "price"]);
});

test("nothing is declared for a method the path has no operation for, a path the document does not have, or a response with no body", () => {
  assert.equal(fieldsOf(SPEC, "/items", "POST"), undefined);
  assert.equal(fieldsOf(SPEC, "/unknown"), undefined);
  assert.equal(fieldsOf(SPEC, "/items/17", "DELETE"), undefined);
});

test("a reference to another file, an ambiguous wrapper and a schema with no properties declare nothing", () => {
  const remote = doc(`
paths:
  /a: { get: { responses: { "200": { content: { application/json: { schema: { $ref: "other.yaml#/Item" } } } } } } }
  /b:
    get:
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  left: { type: array, items: { type: object, properties: { x: {} } } }
                  right: { type: array, items: { type: object, properties: { y: {} } } }
  /c: { get: { responses: { "200": { content: { application/json: { schema: { type: object } } } } } } }
`);
  assert.equal(fieldsOf(remote, "/a"), undefined);
  assert.equal(fieldsOf(remote, "/b"), undefined);
  assert.equal(fieldsOf(remote, "/c"), undefined);
});

test("a swagger 2 response schema is read as an openapi 3 content schema is", () => {
  const v2 = doc(`
swagger: "2.0"
paths:
  /things:
    get:
      responses:
        "200":
          schema:
            type: array
            items:
              type: object
              properties: { id: {}, label: {} }
`);
  assert.deepEqual(fieldsOf(v2, "/things"), ["id", "label"]);
});

test("a document that is not an openapi document declares nothing", () => {
  assert.equal(fieldsOf(undefined, "/items"), undefined);
  assert.equal(fieldsOf("paths", "/items"), undefined);
  assert.equal(fieldsOf({ paths: [] }, "/items"), undefined);
});
