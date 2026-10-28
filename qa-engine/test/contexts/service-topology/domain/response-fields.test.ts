/* The field names an OpenAPI document declares anywhere in an operation's successful JSON response. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { responseFieldNames } from "@contexts/service-topology/domain/response-fields.ts";

const doc = (yaml: string): unknown => parse(yaml);
const fieldsOf = (d: unknown, path: string, method = "GET"): string[] | undefined => {
  const fields = responseFieldNames(d, method, path);
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

test("the names a list operation's response declares are those of every schema it holds, at every depth, references and allOf resolved and a cycle cut", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items"), ["id", "name", "parent", "price"]);
});

test("a wrapper object's own fields are declared as well as those of the items it holds", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items/by-region/ES"), ["category", "id", "name", "results", "total"]);
});

test("an operation that answers one object declares that object's fields", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items/17"), ["id", "name"]);
});

test("a field nested in an object property, in an array of arrays and in additional properties is declared", () => {
  const nested = doc(`
paths:
  /nest:
    get:
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  properties:
                    type: object
                    properties:
                      deep: { type: string }
                  rows:
                    type: array
                    items: { type: array, items: { type: object, properties: { cell: {} } } }
                  extra:
                    type: object
                    additionalProperties: { type: object, properties: { more: {} } }
`);
  assert.deepEqual(fieldsOf(nested, "/nest"), ["cell", "deep", "extra", "more", "properties", "rows"]);
});

test("of the operations a path could belong to, the one with the most literal segments is chosen", () => {
  assert.deepEqual(fieldsOf(SPEC, "/items/by-region/ES"), ["category", "id", "name", "results", "total"]);
});

test("a gateway prefix before the documented path does not hide the operation", () => {
  assert.deepEqual(fieldsOf(SPEC, "/api/items"), ["id", "name", "parent", "price"]);
});

test("nothing is declared for a method the path has no operation for, a path the document does not have, or a response with no body", () => {
  assert.equal(fieldsOf(SPEC, "/items", "POST"), undefined);
  assert.equal(fieldsOf(SPEC, "/unknown"), undefined);
  assert.equal(fieldsOf(SPEC, "/items/17", "DELETE"), undefined);
});

test("a reference to another file and a schema with no properties declare nothing", () => {
  const remote = doc(`
paths:
  /a: { get: { responses: { "200": { content: { application/json: { schema: { $ref: "other.yaml#/Item" } } } } } } }
  /c: { get: { responses: { "200": { content: { application/json: { schema: { type: object } } } } } } }
`);
  assert.equal(fieldsOf(remote, "/a"), undefined);
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
