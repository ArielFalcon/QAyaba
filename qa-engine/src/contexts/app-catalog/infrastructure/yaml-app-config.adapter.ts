import type { AppRepositoryPort, AppConfigSnapshot, RepoRole } from "../application/ports/index.ts";
import { App } from "../domain/app.aggregate.ts";
import { RepoResolutionService } from "../domain/repo-resolution.service.ts";

/* Local shape of the injected loader result so this adapter never imports src/. A service may declare one openapi glob or several. */
interface LegacyConfig {
  name: string; repo: string; baseBranch?: string; code?: boolean;
  qa?: { shadow?: boolean }; services?: { repo: string; openapi?: string | string[]; versionUrl?: string }[];
  dev?: { versionUrl?: string };
}
export interface ConfigLoaders {
  load(name: string): LegacyConfig;
  list(): LegacyConfig[];
}

/** Skip-and-log one bad config so it cannot fail the whole catalog. Injected so this adapter never imports src/. */
export type ConfigSkipLogger = (name: string, err: unknown) => void;

const defaultConfigSkipLogger: ConfigSkipLogger = (name, err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[qa] skipping app config "${name}" — failed aggregate validation: ${msg}`);
};

function toSnapshot(cfg: LegacyConfig): AppConfigSnapshot {
  const app = App.fromConfig({
    name: cfg.name, repo: cfg.repo, baseBranch: cfg.baseBranch ?? "main",
    code: cfg.code ?? false, shadow: cfg.qa?.shadow ?? false,
    services: cfg.services ?? [],
    dev: cfg.dev,
  });
  return {
    name: app.name, repo: app.primaryRepo, baseBranch: app.baseBranch,
    code: app.isCode, shadow: app.isShadow,
    services: (cfg.services ?? []).map((s) => ({ repo: s.repo, ...(s.openapi ? { openapi: s.openapi } : {}), ...(s.versionUrl ? { versionUrl: s.versionUrl } : {}) })),
  };
}

export class YamlAppConfigAdapter implements AppRepositoryPort {
  constructor(
    private readonly loaders: ConfigLoaders,
    private readonly onConfigSkip: ConfigSkipLogger = defaultConfigSkipLogger,
  ) {}

  async load(name: string): Promise<AppConfigSnapshot> {
    return toSnapshot(this.loaders.load(name));
  }

  async list(): Promise<AppConfigSnapshot[]> {
    return this.loaders.list().map(toSnapshot);
  }

  async resolveByRepo(repoSlug: string): Promise<{ app: AppConfigSnapshot; role: RepoRole }[]> {
    /* Call list() once so we do not double-scan the FS or race two list() results. */
    const configs = this.loaders.list();
    /* Per-config skip-and-log: a config that passed the shell zod layer can still fail App.fromConfig; skip it rather than failing the whole catalog. */
    const apps: App[] = [];
    for (const c of configs) {
      try {
        apps.push(App.fromConfig({
          name: c.name, repo: c.repo, baseBranch: c.baseBranch ?? "main",
          code: c.code ?? false, shadow: c.qa?.shadow ?? false, services: c.services ?? [], dev: c.dev,
        }));
      } catch (err) {
        this.onConfigSkip(c.name, err);
      }
    }
    /* Every match: a repo that is primary of one app and service of another fans out to both. Find each cfg from the same local const. */
    return new RepoResolutionService(apps).resolve(repoSlug).map((resolution) => {
      const cfg = configs.find((c) => c.name === resolution.app.name)!;
      return { app: toSnapshot(cfg), role: resolution.role };
    });
  }
}
