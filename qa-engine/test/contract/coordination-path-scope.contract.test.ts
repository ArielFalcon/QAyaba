/* Contract: writable path scope for sidekick (escape rejection). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathWithinWritableRoots } from "@contexts/coordination/application/path-scope.ts";

test("e2e/ prefix allows under e2e and rejects sibling e2evil", () => {
  assert.equal(isPathWithinWritableRoots("e2e/a.spec.ts", ["e2e/"]), true);
  assert.equal(isPathWithinWritableRoots("e2e/a.spec.ts", ["e2e"]), true);
  assert.equal(isPathWithinWritableRoots("./e2e/a.spec.ts", ["e2e/"]), true);
  assert.equal(isPathWithinWritableRoots("e2evil/x", ["e2e/"]), false);
  assert.equal(isPathWithinWritableRoots("src/x.ts", ["e2e/"]), false);
});

test("path escapes and absolute paths are rejected", () => {
  assert.equal(isPathWithinWritableRoots("../secret", ["e2e/"]), false);
  assert.equal(isPathWithinWritableRoots("e2e/../../etc/passwd", ["e2e/"]), false);
  assert.equal(isPathWithinWritableRoots("/etc/passwd", ["e2e/"]), false);
});
