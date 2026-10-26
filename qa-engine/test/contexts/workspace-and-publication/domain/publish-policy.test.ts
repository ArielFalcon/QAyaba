/* The publish policy: which kind a run publishes as, and that the code denylist keeps secrets and artifacts out of the index. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitMessageFor, excludesFor, pathspecsFor, publishKindFor } from "@contexts/workspace-and-publication/domain/publish-policy.ts";
import { CONFINEMENT_DENYLIST } from "@contexts/workspace-and-publication/domain/write-confinement.service.ts";

test("a context run publishes as a context whatever its target; otherwise the target decides", () => {
  assert.equal(publishKindFor(true, "context"), "context");
  assert.equal(publishKindFor(false, "context"), "context");
  assert.equal(publishKindFor(true, "diff"), "code");
  assert.equal(publishKindFor(false, "diff"), "e2e");
});

test("a code publication excludes the whole confinement denylist; a context stages by exact pathspec with nothing to exclude", () => {
  for (const entry of CONFINEMENT_DENYLIST) assert.ok(excludesFor("code").includes(entry), entry);
  assert.deepEqual(excludesFor("context"), []);
  assert.deepEqual(pathspecsFor("context"), ["e2e/.qa/context.json"]);
});

test("an e2e publication never stages the throwaway specs or the saved session", () => {
  assert.ok(excludesFor("e2e").includes("e2e/.qa-probe/"));
  assert.ok(excludesFor("e2e").includes("e2e/.auth/"));
});

test("each kind commits under its own conventional message", () => {
  assert.deepEqual(
    (["e2e", "code", "context"] as const).map(commitMessageFor),
    ["test(e2e): automated QA", "test(code): automated QA", "docs(context): automated QA context map"],
  );
});
