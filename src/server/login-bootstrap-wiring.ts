/* Composition root's side of the automatic login bootstrap (runner.ts, RunnerDeps.suiteHoldsVerifiedLogin): the question it asks of an app's suite store. A frozen request is never asked (run-freeze.ts). */

import { suiteStoreHoldsVerifiedLogin } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter";
import { appSuiteStoreDir } from "./run-engine-factory";

export function suiteHoldsVerifiedLoginFor(root: string): (app: string) => boolean {
  return (app) => suiteStoreHoldsVerifiedLogin(appSuiteStoreDir(root, app));
}
