import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { diffOperations, type OperationChange } from "@contexts/service-topology/domain/operation-diff.ts";

const spec = (yaml: string): unknown => parse(yaml);

const BASE = spec(`
openapi: 3.0.0
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List
      description: Lists orders
      tags: [orders]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
    post:
      operationId: createOrder
      responses:
        "201": { description: created }
  /orders/{id}:
    delete:
      operationId: deleteOrder
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "204": { description: gone }
components:
  schemas:
    Order:
      type: object
      properties:
        id: { type: string }
`);

const changes = (head: unknown): OperationChange[] => diffOperations(BASE, head) ?? [];
const edit = (mutate: (doc: any) => void): unknown => {
  const copy = JSON.parse(JSON.stringify(BASE));
  mutate(copy);
  return copy;
};

test("a changed description, summary, tag or vendor extension does not change an operation", () => {
  const head = edit((d) => {
    d.paths["/orders"].get.description = "Lists every order";
    d.paths["/orders"].get.summary = "All";
    d.paths["/orders"].get.tags = ["sales"];
    d.paths["/orders"].get["x-internal"] = true;
    d.paths["/orders"].get.responses["200"].description = "fine";
  });
  assert.deepEqual(changes(head), []);
});

test("a new optional response field changes the operations that return the schema", () => {
  const head = edit((d) => { d.components.schemas.Order.properties.note = { type: "string" }; });
  assert.deepEqual(changes(head), [{ verb: "GET", path: "/orders", change: "changed" }]);
});

test("a new response status changes only its operation", () => {
  const head = edit((d) => {
    d.paths["/orders/{id}"].delete.responses["404"] = { description: "missing" };
  });
  assert.deepEqual(changes(head), [{ verb: "DELETE", path: "/orders/{id}", change: "changed" }]);
});

test("a removed path is removed and an added path is added", () => {
  const head = edit((d) => {
    delete d.paths["/orders/{id}"];
    d.paths["/customers"] = { get: { operationId: "listCustomers", responses: { "200": { description: "ok" } } } };
  });
  assert.deepEqual(changes(head), [
    { verb: "GET", path: "/customers", change: "added" },
    { verb: "DELETE", path: "/orders/{id}", change: "removed" },
  ]);
});

test("a spec compared with itself, and an unreadable side, yield no per-operation answer to trust", () => {
  assert.deepEqual(diffOperations(BASE, BASE), []);
  assert.equal(diffOperations(BASE, undefined), undefined);
  assert.equal(diffOperations("not a spec", BASE), undefined);
  assert.equal(diffOperations({ openapi: "3.0.0" }, BASE), undefined);
});

test("a reference cycle between schemas does not hang the comparison", () => {
  const cyclic = (extra: boolean): unknown => ({
    paths: { "/n": { get: { responses: { "200": { content: { "a/b": { schema: { $ref: "#/components/schemas/Node" } } } } } } } },
    components: { schemas: { Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" }, ...(extra ? { v: { type: "string" } } : {}) } } } },
  });
  assert.deepEqual(diffOperations(cyclic(false), cyclic(true)), [{ verb: "GET", path: "/n", change: "changed" }]);
});

test("a field named like prose is still a field of the contract", () => {
  const head = edit((d) => { d.components.schemas.Order.properties.description = { type: "string" }; });
  assert.deepEqual(changes(head), [{ verb: "GET", path: "/orders", change: "changed" }]);
});

test("a contract part that references another file cannot be compared, so the caller falls back to the whole file", () => {
  const withRemote = (description: string): unknown => spec(`
openapi: 3.0.0
info: { title: t, version: "1", description: ${description} }
paths:
  /pets:
    get:
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: "schemas.yaml#/Pet"
`);
  assert.equal(diffOperations(withRemote("before"), withRemote("after")), undefined);
});

test("a remote reference only on one side also falls back to the whole file", () => {
  const local = spec(`
openapi: 3.0.0
paths:
  /pets:
    get:
      responses: { "200": { description: ok } }
`);
  const remote = spec(`
openapi: 3.0.0
paths:
  /pets:
    get:
      parameters:
        - $ref: "https://example.test/params.yaml#/Limit"
      responses: { "200": { description: ok } }
`);
  assert.equal(diffOperations(local, remote), undefined);
});
