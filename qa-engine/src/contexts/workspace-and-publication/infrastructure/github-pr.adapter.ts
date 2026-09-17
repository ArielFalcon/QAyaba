import type { GitHubPrPort, PullRequest } from "../application/ports/index.ts";
import { clampTitle, clampBody, type GitHubHttpDeps } from "./github-http.ts";

interface RawPullRequest {
  url: string;
  nodeId: string;
  number: number;
}

export class GitHubPrAdapter implements GitHubPrPort {
  constructor(private readonly http: GitHubHttpDeps, private readonly base = "main") {}

  async openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<PullRequest> {
    const pr = await this.createPullRequest(repo, { title, head: branch, base: this.base, body });
    try {
      await this.enableAutoMerge(pr.nodeId);
    } catch {
      try {
        await this.mergePullRequest(repo, pr.number);
      } catch {
        /* leave open; caller logs */
      }
    }
    return { url: pr.url, number: pr.number };
  }

  private async createPullRequest(
    repo: string,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<RawPullRequest> {
    const res = await this.http.fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: { ...this.http.authHeaders(), Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, title: clampTitle(args.title), body: clampBody(args.body) }),
    });
    if (!res.ok) throw new Error(`GitHub PR error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string; node_id: string; number: number };
    return { url: data.html_url, nodeId: data.node_id, number: data.number };
  }

  private async enableAutoMerge(nodeId: string, mergeMethod = "SQUASH"): Promise<void> {
    const res = await this.http.fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...this.http.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation($id:ID!,$m:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){pullRequest{id}}}",
        variables: { id: nodeId, m: mergeMethod },
      }),
    });
    const data = (await res.json()) as { errors?: Array<{ message: string }> };
    if (!res.ok || data.errors?.length) {
      throw new Error(`GitHub auto-merge: ${data.errors?.[0]?.message ?? res.status}`);
    }
  }

  private async mergePullRequest(repo: string, number: number, mergeMethod = "squash"): Promise<void> {
    const res = await this.http.fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...this.http.authHeaders(), Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: mergeMethod }),
    });
    if (!res.ok) throw new Error(`GitHub merge error ${res.status}: ${await res.text()}`);
  }
}
