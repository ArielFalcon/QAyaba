/* The OpenAPI documents of the working copy, read once, answer which fields an operation's response declares. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadResponseFields } from "@contexts/generation/infrastructure/openapi-response-fields.source.ts";

const SPEC = `
openapi: 3.0.0
paths:
  /items:
    get:
      responses:
        "200":
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties: { id: {}, name: {}, category: {} }
`;

function withMirror(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openapi-fields-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the fields an operation's response declares are answered from the document the app declares", () => {
  withMirror({ "src/main/resources/openapi/api.yaml": SPEC }, (dir) => {
    const fieldsOf = loadResponseFields({ mirrorDir: dir, openapi: "**/openapi/*.yaml" });
    assert.deepEqual([...(fieldsOf?.("GET", "https://app.example/api/items?x=1") ?? [])].sort(), ["category", "id", "name"]);
  });
});

test("without a declared location, a file named like an openapi document is read; one with another name is not", () => {
  withMirror({ "docs/openapi.yaml": SPEC, "docs/notes.yaml": SPEC.replace("/items", "/notes") }, (dir) => {
    const fieldsOf = loadResponseFields({ mirrorDir: dir });
    assert.equal(fieldsOf?.("GET", "https://app.example/items")?.has("category"), true);
    assert.equal(fieldsOf?.("GET", "https://app.example/notes"), undefined);
  });
});

test("a json document is read as a yaml one is", () => {
  withMirror({ "openapi.json": JSON.stringify({ openapi: "3.0.0", paths: { "/items": { get: { responses: { "200": { content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { id: {} } } } } } } } } } } }) }, (dir) => {
    assert.deepEqual([...(loadResponseFields({ mirrorDir: dir })?.("GET", "https://app.example/items") ?? [])], ["id"]);
  });
});

test("a document under a dependency or build directory is not read", () => {
  withMirror({ "node_modules/pkg/openapi.yaml": SPEC }, (dir) => {
    assert.equal(loadResponseFields({ mirrorDir: dir })?.("GET", "https://app.example/items"), undefined);
  });
});

test("a document that cannot be parsed, or an address that is no URL, answers nothing and breaks nothing", () => {
  withMirror({ "openapi.yaml": "paths: [unclosed" }, (dir) => {
    const fieldsOf = loadResponseFields({ mirrorDir: dir });
    assert.equal(fieldsOf?.("GET", "https://app.example/items"), undefined);
    assert.equal(fieldsOf?.("GET", "not a url"), undefined);
  });
});

test("a working copy with no document has no lookup", () => {
  withMirror({ "README.md": "hello" }, (dir) => {
    assert.equal(loadResponseFields({ mirrorDir: dir }), undefined);
  });
});
