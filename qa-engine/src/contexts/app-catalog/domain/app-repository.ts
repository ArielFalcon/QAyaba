/* Watched-app config + cross-repo routing. App-specificity lives only in this context. */

export interface ServiceConfig { repo: string; openapi?: string | string[]; versionUrl?: string; }

export type RepoRole = "primary" | "service";

export interface AppConfigSnapshot {
  name: string; repo: string; baseBranch: string;
  code: boolean; shadow: boolean; services: ServiceConfig[];
}
