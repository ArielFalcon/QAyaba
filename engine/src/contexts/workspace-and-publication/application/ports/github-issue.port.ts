import type { Issue } from "../../domain/vcs-write.ts";

export interface GitHubIssuePort {
  open(repo: string, title: string, body: string): Promise<Issue>;
}
