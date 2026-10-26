import type { PullRequest } from "../../domain/vcs-write.ts";

export interface GitHubPrPort {
  openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<PullRequest>;
}
