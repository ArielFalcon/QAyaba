import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { assertCommitSha, assertRefName, isCommitSha, isObjectName, isRefName } from "@kernel/git-revision.ts";

test("a commit sha is 7 to 40 hex characters and nothing else", () => {
  for (const sha of ["abc1234", "ABC1234", "0123456789abcdef0123456789abcdef01234567"]) assert.equal(isCommitSha(sha), true, sha);
  for (const sha of ["abc123", `${"a".repeat(41)}`, "--output=/tmp/x", "-abc1234", "abc1234\n", "abc 1234", "main", "", undefined, null, 7, {}]) assert.equal(isCommitSha(sha), false, String(sha));
});

test("an object name is a commit sha that may be abbreviated down to git's smallest abbreviation", () => {
  for (const name of ["abcd", "abc123", "abc1234", "ABCD", "a".repeat(40)]) assert.equal(isObjectName(name), true, name);
  for (const name of ["abc", `${"a".repeat(41)}`, "--output=/tmp/x", "abcd\n", "main", "", undefined, 4]) assert.equal(isObjectName(name), false, String(name));
  for (const sha of ["abc1234", "a".repeat(40)]) assert.equal(isObjectName(sha) && isCommitSha(sha), true, "every commit sha is an object name");
});

test("assertCommitSha names the value it refused", () => {
  assert.doesNotThrow(() => assertCommitSha("abc1234"));
  assert.throws(() => assertCommitSha("--output=/etc/passwd"), /invalid commit sha \(must be 7–40 hex chars\): "--output=\/etc\/passwd"/);
});

/* The rule is git's own (git check-ref-format) plus "never starts with a dash": a name this accepts is one git accepts as a ref, and it can never be read as an option. */
const REF_NAMES = [
  "main", "feature/login", "release-1.2", "v1.2.3", "refs/heads/main", "qa_test-ab12cd3", "fix@home", "a+b", "ñame-1", "a.b", "x/y/z",
  "-x", "--upload-pack=touch /tmp/x", "-", "--output=/tmp/x", "", "/a", "a/", "a//b", "a..b", ".a", "a/.b", "a.", "a.lock", "a/b.lock", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a@{1}", "@", "a\u0001b", "a\u007fb", "a\tb", "a\nb",
];

test("a ref name is accepted exactly when git accepts it as a ref and it does not start with a dash", () => {
  for (const name of REF_NAMES) {
    let gitAccepts = true;
    try {
      execFileSync("git", ["check-ref-format", `refs/heads/${name}`], { stdio: "ignore" });
    } catch {
      gitAccepts = false;
    }
    assert.equal(isRefName(name), gitAccepts && !name.startsWith("-") && name !== "", JSON.stringify(name));
  }
});

test("assertRefName names what it refused", () => {
  assert.doesNotThrow(() => assertRefName("main"));
  assert.throws(() => assertRefName("--upload-pack=x"), /invalid ref name: "--upload-pack=x"/);
  assert.throws(() => assertRefName("-x", "branch name"), /invalid branch name: "-x"/);
  assert.throws(() => assertRefName(undefined), /invalid ref name/);
});
