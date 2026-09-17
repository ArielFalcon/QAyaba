/* Watched-app config + cross-repo routing. App-specificity lives only in this context. */

export interface ServiceConfig { repo: string; openapi?: string | string[]; versionUrl?: string; }
export type RepoRole = "primary" | "service";
export interface AppConfigSnapshot {
  name: string; repo: string; baseBranch: string;
  code: boolean; shadow: boolean; services: ServiceConfig[];
}
export interface AppRepositoryPort {
  load(name: string): Promise<AppConfigSnapshot>;
  list(): Promise<AppConfigSnapshot[]>;
  /** Every app the repo participates in — primary of one and service of another fans out to both (webhook enqueues one run per match). Empty when unwatched. */
  resolveByRepo(repoSlug: string): Promise<{ app: AppConfigSnapshot; role: RepoRole }[]>;
}
export interface RepoInfoPort {
  defaultBranch(repoSlug: string): Promise<string>;
}
