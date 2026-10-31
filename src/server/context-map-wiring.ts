/* Composition root's side of the context-map rebuild before a run (runner.ts, RunnerDeps.contextMapNeedsRebuild): the question it asks of an app's stored map. A frozen request is never asked (run-freeze.ts). */

import { contextMapValidity, type ChangedFile } from "@contexts/run-orchestration/application/index";
import { loadAppConfig, type AppConfig } from "../orchestrator/config-loader";
import { ensureMirror, defaultMirrorDeps } from "../integrations/repo-mirror";
import { getHistory } from "./persistence/index";
import type { StoredContextMap } from "./persistence/repositories/context.repository";
import { gitChangedFiles } from "./run-engine-factory";

export interface ContextMapQuestionDeps {
  loadApp: (name: string) => AppConfig;
  loadStoredMap: (app: string) => StoredContextMap | undefined;
  isStale: (app: string) => boolean;
  /* Brings the app's primary mirror to the commit and returns its directory. */
  syncMirror: (repo: string, sha: string) => Promise<string>;
  changesBetween: (repoDir: string, fromSha: string, toSha: string) => ChangedFile[] | undefined;
}

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

const defaultDeps: ContextMapQuestionDeps = {
  loadApp: loadAppConfig,
  loadStoredMap: (app) => getHistory().contexts.loadContextMap(app),
  isStale: (app) => getHistory().contexts.isContextStale(app),
  syncMirror: (repo, sha) => ensureMirror(repo, sha, defaultMirrorDeps),
  changesBetween: gitChangedFiles,
};

/*
 * Whether an app's stored context map fails to describe a commit: there is none, the process audit marked it stale, or the files it
 * names changed in a way context-map-validity.ts does not keep (a commit pair that cannot be compared included).
 */
export function contextMapNeedsRebuildFor(deps: ContextMapQuestionDeps = defaultDeps): (app: string, sha: string) => Promise<boolean> {
  return async (appName, sha) => {
    const app = deps.loadApp(appName);
    const stored = deps.loadStoredMap(appName);
    if (!stored || deps.isStale(appName)) return true;
    if (stored.builtAtSha === sha) return false;
    /* A recorded commit that is not a sha is never handed to git; the map is rebuilt instead. */
    if (!HEX_SHA.test(stored.builtAtSha)) return true;
    const mirrorDir = await deps.syncMirror(app.repo, sha);
    return !contextMapValidity(stored.data, stored.builtAtSha, sha, deps.changesBetween(mirrorDir, stored.builtAtSha, sha)).valid;
  };
}
