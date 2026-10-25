/* Composition root's side of the context-map rebuild before a run (runner.ts, RunnerDeps.contextMapNeedsRebuild): the question it asks of an app's stored map, and the switch that turns it off. */

import { contextMapValidity, type ChangedFile } from "@contexts/qa-run-orchestration/domain/context-map-validity";
import { loadAppConfig, type AppConfig } from "../orchestrator/config-loader";
import { ensureMirror, defaultMirrorDeps } from "../integrations/repo-mirror";
import { resolveCampaignFreeze } from "./campaign-freeze";
import { isContextStale, loadContextMap, type StoredContextMap } from "./history";
import { gitChangedFiles } from "./rewritten-engine-factory";

export interface ContextMapQuestionDeps {
  loadApp: (name: string) => AppConfig;
  loadStoredMap: (app: string) => StoredContextMap | undefined;
  isStale: (app: string) => boolean;
  /* Brings the app's primary mirror to the commit and returns its directory. */
  syncMirror: (repo: string, sha: string) => Promise<string>;
  changesBetween: (repoDir: string, fromSha: string, toSha: string) => ChangedFile[] | undefined;
}

const defaultDeps: ContextMapQuestionDeps = {
  loadApp: loadAppConfig,
  loadStoredMap: loadContextMap,
  isStale: isContextStale,
  syncMirror: (repo, sha) => ensureMirror(repo, sha, defaultMirrorDeps),
  changesBetween: gitChangedFiles,
};

/*
 * Whether an app's stored context map fails to describe a commit: there is none, the process audit marked it stale, or the files it
 * names changed in a way context-map-validity.ts does not keep (a commit pair that cannot be compared included). A code app has no
 * map. Undefined under QA_CAMPAIGN_FREEZE: a campaign keeps the map it started with.
 */
export function contextMapNeedsRebuildFor(env: Record<string, string | undefined>, deps: ContextMapQuestionDeps = defaultDeps): ((app: string, sha: string) => Promise<boolean>) | undefined {
  if (resolveCampaignFreeze(env)) return undefined;
  return async (appName, sha) => {
    const app = deps.loadApp(appName);
    if (app.code === true) return false;
    const stored = deps.loadStoredMap(appName);
    if (!stored || deps.isStale(appName)) return true;
    if (stored.builtAtSha === sha) return false;
    const mirrorDir = await deps.syncMirror(app.repo, sha);
    return !contextMapValidity(stored.data, stored.builtAtSha, sha, deps.changesBetween(mirrorDir, stored.builtAtSha, sha)).valid;
  };
}
