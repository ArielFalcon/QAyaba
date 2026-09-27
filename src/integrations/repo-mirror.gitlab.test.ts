import { test } from "node:test";
import assert from "node:assert/strict";
import { authHeaderArgs, gitRemoteBase, isGithubRemote, getRepoInfoViaGit, ensureMirror, type MirrorDeps } from "./repo-mirror";

test("authHeaderArgs: default GitHub rewrite is unchanged (x-access-token on github.com)", () => {
  assert.deepEqual(authHeaderArgs({ GITHUB_TOKEN: "sekret-token" }), [
    "-c",
    "url.https://x-access-token:sekret-token@github.com/.insteadOf=https://github.com/",
  ]);
});

test("authHeaderArgs: no token → no rewrite", () => {
  assert.deepEqual(authHeaderArgs({ GIT_REMOTE_BASE: "https://gitlab.bank.local" }), []);
});

test("authHeaderArgs: a GitLab remote is rewritten for ITS host with the oauth2 user and GIT_TOKEN", () => {
  assert.deepEqual(authHeaderArgs({ GIT_REMOTE_BASE: "https://gitlab.bank.local/", GIT_TOKEN: "glpat-abcdefghijklmnopqrstu" }), [
    "-c",
    "url.https://oauth2:glpat-abcdefghijklmnopqrstu@gitlab.bank.local/.insteadOf=https://gitlab.bank.local/",
  ]);
});

test("authHeaderArgs: GIT_TOKEN wins over GITHUB_TOKEN; GIT_TOKEN_USER overrides the user", () => {
  const args = authHeaderArgs({ GIT_REMOTE_BASE: "https://scm.local", GIT_TOKEN: "t1", GITHUB_TOKEN: "t2", GIT_TOKEN_USER: "deploy-bot" });
  assert.equal(args[1], "url.https://deploy-bot:t1@scm.local/.insteadOf=https://scm.local/");
});

test("authHeaderArgs: a path-prefixed remote keeps its prefix and URL-encodes the credentials", () => {
  const args = authHeaderArgs({ GIT_REMOTE_BASE: "https://host.local/gitlab", GIT_TOKEN: "a/b@c", GIT_TOKEN_USER: "u:x" });
  assert.equal(args[1], "url.https://u%3Ax:a%2Fb%40c@host.local/gitlab/.insteadOf=https://host.local/gitlab/");
});

test("authHeaderArgs: an invalid GIT_REMOTE_BASE fails loud", () => {
  assert.throws(() => authHeaderArgs({ GIT_REMOTE_BASE: "not a url", GIT_TOKEN: "t" }), /GIT_REMOTE_BASE is not a valid URL/);
});

test("gitRemoteBase / isGithubRemote", () => {
  assert.equal(gitRemoteBase({}), "https://github.com");
  assert.equal(gitRemoteBase({ GIT_REMOTE_BASE: "https://gitlab.bank.local//" }), "https://gitlab.bank.local");
  assert.equal(isGithubRemote({}), true);
  assert.equal(isGithubRemote({ GIT_REMOTE_BASE: "https://gitlab.bank.local" }), false);
});

test("nested GitLab groups clone from <base>/<group>/<sub>/<project>.git into a flattened mirror dir", async () => {
  const prev = process.env.GIT_REMOTE_BASE;
  process.env.GIT_REMOTE_BASE = "https://gitlab.bank.local";
  try {
    const calls: string[][] = [];
    const deps: MirrorDeps = {
      root: "/tmp/mirrors",
      exists: () => false,
      removeFile: () => {},
      git: async (args) => {
        calls.push(args);
        return "";
      },
    };
    await ensureMirror("group/sub/shop", "abc1234", deps);
    const clone = calls.find((c) => c.includes("clone"))!;
    assert.deepEqual(clone.slice(clone.indexOf("clone")), ["clone", "https://gitlab.bank.local/group/sub/shop.git", "/tmp/mirrors/group__sub__shop"]);
  } finally {
    if (prev === undefined) delete process.env.GIT_REMOTE_BASE;
    else process.env.GIT_REMOTE_BASE = prev;
  }
});

test("getRepoInfoViaGit reads the default branch from ls-remote --symref", async () => {
  const deps: MirrorDeps = {
    exists: () => false,
    removeFile: () => {},
    git: async () => "ref: refs/heads/develop\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
  };
  assert.deepEqual(await getRepoInfoViaGit("group/sub/shop", deps), {
    name: "shop",
    fullName: "group/sub/shop",
    private: true,
    defaultBranch: "develop",
    description: null,
  });
});

test("getRepoInfoViaGit fails loud when HEAD cannot be resolved", async () => {
  const deps: MirrorDeps = { exists: () => false, removeFile: () => {}, git: async () => "" };
  await assert.rejects(getRepoInfoViaGit("group/empty", deps), /could not resolve the default branch/);
});
