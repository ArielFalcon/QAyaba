/* Composition root's side of the automatic login bootstrap (runner.ts, RunnerDeps.suiteHoldsVerifiedLogin): the question it asks of an app's suite store, and the switch that turns it off. */

import { suiteStoreHoldsVerifiedLogin } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter";
import { resolveCampaignFreeze } from "./campaign-freeze";
import { appSuiteStoreDir } from "./rewritten-engine-factory";

/* Undefined under QA_CAMPAIGN_FREEZE: a campaign seeds the store itself before each arm-run, so a run must not warm it on its own. */
export function suiteHoldsVerifiedLoginFor(env: Record<string, string | undefined>, root: string): ((app: string) => boolean) | undefined {
  if (resolveCampaignFreeze(env)) return undefined;
  return (app) => suiteStoreHoldsVerifiedLogin(appSuiteStoreDir(root, app));
}
