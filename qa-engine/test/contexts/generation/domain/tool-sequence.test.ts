import { test } from "node:test";
import assert from "node:assert/strict";
import { isPermissionDenial, toolCallSubject } from "@contexts/generation/domain/tool-sequence.ts";

test("a file tool's subject is its path", () => {
  assert.deepEqual(toolCallSubject({ filePath: "src/a.ts", offset: 3 }), { kind: "path", value: "src/a.ts" });
  assert.deepEqual(toolCallSubject({ relative_path: "src/b.ts" }), { kind: "path", value: "src/b.ts" });
});

test("a search's subject is its pattern, and the path it searched in is its scope", () => {
  assert.deepEqual(toolCallSubject({ pattern: "createUser", path: "src" }), { kind: "pattern", value: "createUser", scope: "src" });
  assert.deepEqual(toolCallSubject({ pattern: "**/*.ts" }), { kind: "pattern", value: "**/*.ts" });
  assert.deepEqual(toolCallSubject({ substring_pattern: "foo", relative_path: "lib" }), { kind: "pattern", value: "foo", scope: "lib" });
});

test("a browser call's subject is its url, else the element it names", () => {
  assert.deepEqual(toolCallSubject({ url: "https://a.test/x" }), { kind: "url", value: "https://a.test/x" });
  assert.deepEqual(toolCallSubject({ element: "Save button", ref: "e3", text: "typed text" }), { kind: "element", value: "Save button" });
});

test("a shell call's subject is its command line, a memory search's its query", () => {
  assert.deepEqual(toolCallSubject({ command: "npx playwright test", description: "run" }), { kind: "command", value: "npx playwright test" });
  assert.deepEqual(toolCallSubject({ cmd: "ls" }), { kind: "command", value: "ls" });
  assert.deepEqual(toolCallSubject({ query: "login flow" }), { kind: "query", value: "login flow" });
});

test("a call that points at nothing, or whose input is not an object, has no subject", () => {
  assert.equal(toolCallSubject({ content: "body", title: "t" }), undefined);
  assert.equal(toolCallSubject({}), undefined);
  assert.equal(toolCallSubject(undefined), undefined);
  assert.equal(toolCallSubject("not an object"), undefined);
  assert.equal(toolCallSubject({ filePath: "" }), undefined);
});

test("only the runtime's own permission-rule message is a denial", () => {
  assert.equal(
    isPermissionDenial("The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []"),
    true,
  );
  assert.equal(isPermissionDenial("File not found"), false);
  assert.equal(isPermissionDenial(undefined), false);
  assert.equal(isPermissionDenial(42), false);
});
