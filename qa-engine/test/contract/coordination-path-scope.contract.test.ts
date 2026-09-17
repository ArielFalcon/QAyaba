/* Contract: writable path scope for sidekick (code-mode "." and escape rejection). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathWithinWritableRoots } from "@contexts/qa-run-orchestration/application/coordination/path-scope.ts";

test("code-mode root '.' allows relative project paths", () => {
  assert.equal(isPathWithinWritableRoots("src/foo.test.ts", ["."]), true);
  assert.equal(isPathWithinWritableRoots("./src/foo.test.ts", ["."]), true);
  assert.equal(isPathWithinWritableRoots("e2e/a.spec.ts", ["."]), true);
});

test("code-mode root '.' rejects path escapes and absolute paths", () => {
  assert.equal(isPathWithinWritableRoots("../secret", ["."]), false);
  assert.equal(isPathWithinWritableRoots("foo/../../etc/passwd", ["."]), false);
  assert.equal(isPathWithinWritableRoots("/etc/passwd", ["."]), false);
});

test("e2e/ prefix allows under e2e and rejects sibling e2evil", () => {
  assert.equal(isPathWithinWritableRoots("e2e/a.spec.ts", ["e2e/"]), true);
  assert.equal(isPathWithinWritableRoots("e2e/a.spec.ts", ["e2e"]), true);
  assert.equal(isPathWithinWritableRoots("./e2e/a.spec.ts", ["e2e/"]), true);
  assert.equal(isPathWithinWritableRoots("e2evil/x", ["e2e/"]), false);
  assert.equal(isPathWithinWritableRoots("src/x.ts", ["e2e/"]), false);
});
