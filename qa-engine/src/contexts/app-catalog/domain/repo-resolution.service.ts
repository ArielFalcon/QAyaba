import type { App } from "./app.aggregate.ts";
import type { RepoRole } from "../application/ports/index.ts";

export interface RepoResolution { app: App; role: RepoRole; }

/** Resolves a repo slug to every owning App + role. Pure over App aggregates. A repo can be primary of one app and service of another, so the result is an array (webhook enqueues one run per match). Unknown slug → [] — never throws. */
export class RepoResolutionService {
  constructor(private readonly apps: readonly App[]) {}
  resolve(repoSlug: string): RepoResolution[] {
    const matches: RepoResolution[] = [];
    for (const app of this.apps) {
      if (app.primaryRepo === repoSlug) matches.push({ app, role: "primary" });
      else if (app.serviceRepos.includes(repoSlug)) matches.push({ app, role: "service" });
    }
    return matches;
  }
}
