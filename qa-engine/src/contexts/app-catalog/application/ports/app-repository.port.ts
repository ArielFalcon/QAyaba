import type { AppConfigSnapshot, RepoRole } from "../../domain/app-repository.ts";

export interface AppRepositoryPort {
  load(name: string): Promise<AppConfigSnapshot>;
  list(): Promise<AppConfigSnapshot[]>;
  /** Every app the repo participates in — primary of one and service of another fans out to both (webhook enqueues one run per match). Empty when unwatched. */
  resolveByRepo(repoSlug: string): Promise<{ app: AppConfigSnapshot; role: RepoRole }[]>;
}
