/* The publish policy: which kind a run publishes as, and what each kind stages, excludes and commits under. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitMessageFor, excludesFor, pathspecsFor, publishKindFor } from "@contexts/workspace-and-publication/domain/publish-policy.ts";

test("a context run publishes as a context; every other mode publishes as e2e", () => {
  assert.equal(publishKindFor("context"), "context");
  assert.equal(publishKindFor("diff"), "e2e");
});

test("a context stages by exact pathspec with nothing to exclude", () => {
  assert.deepEqual(excludesFor("context"), []);
  assert.deepEqual(pathspecsFor("context"), ["e2e/.qa/context.json"]);
});

test("an e2e publication never stages the throwaway specs or the saved session", () => {
  assert.ok(excludesFor("e2e").includes("e2e/.qa-probe/"));
  assert.ok(excludesFor("e2e").includes("e2e/.auth/"));
});

test("each kind commits under its own conventional message", () => {
  assert.deepEqual(
    (["e2e", "context"] as const).map(commitMessageFor),
    ["test(e2e): automated QA", "docs(context): automated QA context map"],
  );
});
