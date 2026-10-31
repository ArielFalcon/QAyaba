/* Composition root's side of the context-map rebuild before a run (runner.ts, RunnerDeps.contextMapNeedsRebuild): the ports the engine's question reads an app's stored map through. A frozen request is never asked (run-freeze.ts). */

import { contextMapNeedsRebuild, type ContextMapRebuildPorts } from "@contexts/run-orchestration/application/index";
import { loadAppConfig } from "./config-loader";
import { ensureMirror, defaultMirrorDeps } from "./repo-mirror";
import { getHistory } from "../persistence/index";
import { gitChangedFiles } from "./run-engine-factory";

const defaultPorts: ContextMapRebuildPorts = {
  loadApp: loadAppConfig,
  loadStoredMap: (app) => getHistory().contexts.loadContextMap(app),
  isStale: (app) => getHistory().contexts.isContextStale(app),
  syncMirror: (repo, sha) => ensureMirror(repo, sha, defaultMirrorDeps),
  changesBetween: gitChangedFiles,
};

export function contextMapNeedsRebuildFor(ports: ContextMapRebuildPorts = defaultPorts): (app: string, sha: string) => Promise<boolean> {
  return contextMapNeedsRebuild(ports);
}
