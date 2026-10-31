import { requireEnv } from "../settings/env";

export interface GitHubDeps {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export const defaultGitHubDeps: GitHubDeps = {
  fetch: (input, init?) => globalThis.fetch(input, init),
};

export interface RepoInfo {
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

export const github = {
  async getRepo(repo: string, deps: GitHubDeps = defaultGitHubDeps): Promise<RepoInfo> {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}`, {
      headers: ghHeaders(),
    });
    if (res.status === 404) {
      throw new Error(`repo '${repo}' not found or token lacks access (private repo needs GITHUB_TOKEN with 'repo' scope)`);
    }
    if (!res.ok) throw new Error(`GitHub get repo error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      name: string; full_name: string; private: boolean;
      default_branch: string; description: string | null;
    };
    return {
      name: data.name,
      fullName: data.full_name,
      private: data.private,
      defaultBranch: data.default_branch,
      description: data.description,
    };
  },

  async listRepos(owner: string, page = 1, perPage = 10, deps: GitHubDeps = defaultGitHubDeps): Promise<{ repos: RepoInfo[]; hasMore: boolean }> {
    const ghRepos = async (endpoint: string): Promise<Response | null> => {
      const url = `https://api.github.com/${endpoint}?per_page=${perPage}&page=${page}&sort=updated`;
      const res = await deps.fetch(url, { headers: ghHeaders() });
      if (res.status === 404) return null;
      if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
        const reset = res.headers.get("X-RateLimit-Reset");
        const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
        throw new Error(`GitHub API rate limit exceeded — resets at ${resetDate}. Wait or use a token with higher limits.`);
      }
      if (!res.ok) throw new Error(`GitHub list repos error ${res.status}: ${await res.text()}`);
      return res;
    };

    let res: Response | null;
    if (owner === "@me" || !owner) {
      res = await ghRepos("user/repos");
      if (!res) throw new Error("no repos found for your account — check GITHUB_TOKEN has 'repo' or 'public_repo' scope");
    } else {
      res = await ghRepos(`users/${encodeURIComponent(owner)}/repos`);
      if (!res) res = await ghRepos(`orgs/${encodeURIComponent(owner)}/repos`);
      if (!res) throw new Error(`no repos found for '${owner}' — check the name is correct and the token has access`);
    }

    const items = (await res.json()) as Array<{
      name: string; full_name: string; private: boolean;
      default_branch: string; description: string | null;
    }>;
    return {
      repos: items.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
      })),
      hasMore: items.length === perPage,
    };
  },
};
