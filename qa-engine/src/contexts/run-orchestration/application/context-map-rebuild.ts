/* The question behind the context-map rebuild before a run (RunnerDeps.contextMapNeedsRebuild): whether an app's stored map fails to describe a commit. */
import { contextMapValidity, type ChangedFile } from "../domain/context-map-validity.ts";

export interface ContextMapRebuildPorts {
  loadApp: (name: string) => { repo: string };
  loadStoredMap: (app: string) => { builtAtSha: string; data: Parameters<typeof contextMapValidity>[0] } | undefined;
  isStale: (app: string) => boolean;
  /* Brings the app's primary mirror to the commit and returns its directory. */
  syncMirror: (repo: string, sha: string) => Promise<string>;
  changesBetween: (repoDir: string, fromSha: string, toSha: string) => ChangedFile[] | undefined;
}

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

/*
 * Whether an app's stored context map fails to describe a commit: there is none, the process audit marked it stale, or the files it
 * names changed in a way context-map-validity.ts does not keep (a commit pair that cannot be compared included).
 */
export function contextMapNeedsRebuild(ports: ContextMapRebuildPorts): (app: string, sha: string) => Promise<boolean> {
  return async (appName, sha) => {
    const app = ports.loadApp(appName);
    const stored = ports.loadStoredMap(appName);
    if (!stored || ports.isStale(appName)) return true;
    if (stored.builtAtSha === sha) return false;
    /* A recorded commit that is not a sha is never handed to git; the map is rebuilt instead. */
    if (!HEX_SHA.test(stored.builtAtSha)) return true;
    const mirrorDir = await ports.syncMirror(app.repo, sha);
    return !contextMapValidity(stored.data, stored.builtAtSha, sha, ports.changesBetween(mirrorDir, stored.builtAtSha, sha)).valid;
  };
}
