import { test } from "node:test";
import assert from "node:assert/strict";
import { isRepoSlug } from "@contexts/app-catalog/domain/repo-slug.ts";

test("a repository is parts joined by a slash, each starting with a letter or digit", () => {
  for (const repo of ["org/repo", "my.org/re_po-1", "a/b", "Org9/x.y", "store", "group/sub/repo"]) assert.equal(isRepoSlug(repo), true, repo);
  for (const repo of ["..", ".", "org/..", "../repo", "org/.", ".hidden/repo", "org/../repo", "org//repo", "/org/repo", "org/repo/", "-org/repo", "org/-repo", "org/re po", "org/re\nx", ""]) {
    assert.equal(isRepoSlug(repo), false, JSON.stringify(repo));
  }
  for (const value of [undefined, null, 42, ["org/repo"]]) assert.equal(isRepoSlug(value), false, String(value));
});
