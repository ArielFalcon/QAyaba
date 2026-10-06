import type { GitHubIssuePort, Issue } from "../application/ports/index.ts";
import { clampTitle, clampBody, type GitHubHttpDeps } from "./github-http.ts";

export class GitHubIssueAdapter implements GitHubIssuePort {
  constructor(private readonly http: GitHubHttpDeps) {}

  async open(repo: string, title: string, body: string): Promise<Issue> {
    const res = await this.http.fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { ...this.http.authHeaders(), Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: clampTitle(title), body: clampBody(body) }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string };
    const url = data.html_url;
    const match = url.match(/\/issues\/(\d+)/);
    /* Never return a sentinel 0 (or any other made-up) issue number on a parse miss — a
       fabricated number would be silently wrong in every caller that logs or links it back
       to GitHub. Throw instead: a genuine API response we can't parse is a bug worth surfacing
       loudly, not papering over with a fake identifier. */
    if (!match) throw new Error(`GitHubIssueAdapter: cannot parse issue number from URL: ${url}`);
    return { url, number: Number(match[1]) };
  }
}
