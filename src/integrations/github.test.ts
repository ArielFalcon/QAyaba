import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { github, GitHubDeps } from "./github";

describe("github", () => {
  /* ghHeaders() requires GITHUB_TOKEN; provide a dummy so the tests exercise the fetch logic, not the
     env-check logic. The process is shared with other test files, so the token is put back as it was
     once these tests end.
   */
  const savedToken = process.env.GITHUB_TOKEN;
  before(() => {
    process.env.GITHUB_TOKEN = "ghp_dummy_token_for_tests";
  });
  after(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  function mockDeps(response: { ok: boolean; status: number; statusText?: string; json?: unknown; headers?: Record<string, string> }): GitHubDeps {
    return {
      fetch: async () =>
        ({
          ok: response.ok,
          status: response.status,
          statusText: response.statusText ?? "",
          headers: {
            get: (k: string) => (response.headers ? response.headers[k] : null),
          },
          text: async () => JSON.stringify(response.json ?? {}),
          json: async () => response.json ?? {},
        }) as unknown as Response,
    };
  }

  test("getRepo throws with specific message on 404", async () => {
    const deps = mockDeps({ ok: false, status: 404 });
    await assert.rejects(() => github.getRepo("org/nonexistent", deps), /repo 'org\/nonexistent' not found/);
  });

  test("getRepo throws on other errors", async () => {
    const deps = mockDeps({ ok: false, status: 500 });
    await assert.rejects(() => github.getRepo("org/app", deps), /GitHub get repo error 500/);
  });

  test("listRepos throws on rate limit with reset time", async () => {
    const deps = mockDeps({
      ok: false,
      status: 403,
      headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) },
    });
    await assert.rejects(() => github.listRepos("org", 1, 10, deps), /rate limit exceeded/);
  });

  test("listRepos throws when neither user nor org repos are found", async () => {
    const deps = mockDeps({ ok: false, status: 404 });
    await assert.rejects(() => github.listRepos("ghost-owner", 1, 10, deps), /no repos found/);
  });
});
