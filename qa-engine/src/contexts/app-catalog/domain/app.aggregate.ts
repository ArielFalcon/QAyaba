export interface AppServiceConfig { repo: string; openapi?: string | string[]; versionUrl?: string; }
export interface AppConfigInput {
  name: string; repo: string; baseBranch: string;
  shadow: boolean;
  services: AppServiceConfig[];
  dev?: { versionUrl?: string } | undefined;
}

/** Watched-app aggregate. App-specificity lives only in this context. */
export class App {
  private constructor(private readonly cfg: AppConfigInput) {}

  static fromConfig(cfg: AppConfigInput): App {
    /* The dev requirement is duplicated, word-for-word equivalent, in src/orchestrator/schemas.ts AppConfigSchema.refine. There is no compiler/test tie — change either side and update the other, or the two validators drift. */
    if (cfg.dev === undefined) {
      throw new Error("dev is required");
    }
    const serviceRepoSet = cfg.services.map((s) => s.repo);
    if (serviceRepoSet.includes(cfg.repo)) {
      throw new Error(`service repo "${cfg.repo}" must not equal the primary repo (circular dependency)`);
    }
    if (new Set(serviceRepoSet).size !== serviceRepoSet.length) {
      throw new Error("service repos must be unique — duplicate service repo found");
    }
    return new App(cfg);
  }

  get name(): string { return this.cfg.name; }
  get primaryRepo(): string { return this.cfg.repo; }
  get baseBranch(): string { return this.cfg.baseBranch; }
  get isShadow(): boolean { return this.cfg.shadow; }
  get serviceRepos(): string[] { return this.cfg.services.map((s) => s.repo); }
}
