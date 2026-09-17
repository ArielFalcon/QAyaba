export interface AppServiceConfig { repo: string; openapi?: string | string[]; versionUrl?: string; }
export interface AppConfigInput {
  name: string; repo: string; baseBranch: string;
  code: boolean; shadow: boolean;
  services: AppServiceConfig[];
  dev?: { versionUrl?: string } | undefined;
}

/** Watched-app aggregate. App-specificity lives only in this context. */
export class App {
  private constructor(private readonly cfg: AppConfigInput) {}

  static fromConfig(cfg: AppConfigInput): App {
    /* Invariant 1 (dev required unless code) and Invariant 2 (services are e2e-only) are duplicated, word-for-word equivalent, in src/orchestrator/schemas.ts AppConfigSchema.refine. There is no compiler/test tie — change either side and update the other, or the two validators drift. */
    /* Invariant 1: dev required unless code mode (code apps have no web environment). */
    if (!cfg.code && cfg.dev === undefined) {
      throw new Error("dev is required unless code: true (code mode has no web environment)");
    }
    /* Invariant 2: services are e2e-only. */
    if (cfg.code && cfg.services.length > 0) {
      throw new Error("services are only valid for e2e apps (code-mode apps have no E2E suite)");
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
  get isCode(): boolean { return this.cfg.code; }
  get isShadow(): boolean { return this.cfg.shadow; }
  get serviceRepos(): string[] { return this.cfg.services.map((s) => s.repo); }
}
