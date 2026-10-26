export interface RepoInfoPort {
  defaultBranch(repoSlug: string): Promise<string>;
}
