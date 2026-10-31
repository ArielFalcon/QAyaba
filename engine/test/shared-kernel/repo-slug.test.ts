import { test } from "node:test";
import assert from "node:assert/strict";
import { isRepoSlug } from "@kernel/repo-slug.ts";

test("a repository is parts joined by a slash, as GitHub names them, a part starting with . or _ included", () => {
  for (const repo of ["org/repo", "my.org/re_po-1", "a/b", "Org9/x.y", "store", "group/sub/repo", "org/.github", "org/_private", "org/...x"]) {
    assert.equal(isRepoSlug(repo), true, repo);
  }
});

test("a part that is . or .., an empty part, a leading dash or any other character is refused", () => {
  for (const repo of ["..", ".", "org/..", "../repo", "org/.", "org/../repo", "org//repo", "/org/repo", "org/repo/", "-org/repo", "org/-repo", "org/re po", "org/re\nx", "org\\repo", "org/%2e%2e", ""]) {
    assert.equal(isRepoSlug(repo), false, JSON.stringify(repo));
  }
  for (const value of [undefined, null, 42, ["org/repo"]]) assert.equal(isRepoSlug(value), false, String(value));
});
