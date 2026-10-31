/*
 * Whether a run starts from a fixed state, decided once per request and read by every part of the run that depends on it: the record
 * (`effectiveConfig.campaignFreeze`), the runner's two pre-run steps (the automatic login bootstrap and the context-map rebuild) and
 * the engine's composition (suite store read-only, no context-heal request, no process audit).
 *
 * A run that names a campaign is frozen, whatever the process environment says and whatever its variant labels say: the replicates of
 * one commit must not start from what the previous one left. `lessons` is the one thing a request may lift: the lesson state
 * (cross-run observations of DEV, docs/architecture/rfc/0013-learning-slice.md) is read by a run that is not campaign-tagged, or by a
 * campaign-tagged run that declares `grounding.lessons: true`; the replicate isolation and the process audit stay withheld.
 */

import type { GroundingInput } from "./contract/commands";

export interface RunFreeze {
  /* The suite store is read-only, the context map is not rebuilt, no automatic login bootstrap is queued, no process audit is built. */
  readonly frozen: boolean;
  /* The run reads the lessons derived from earlier runs' observations. */
  readonly lessons: boolean;
}

/* The part of a run request the decision reads. */
export interface RunFreezeRequest {
  readonly campaign?: unknown;
  readonly grounding?: GroundingInput | undefined;
}

export function decideRunFreeze(request: RunFreezeRequest): RunFreeze {
  const campaignTagged = request.campaign !== undefined;
  return { frozen: campaignTagged, lessons: request.grounding?.lessons ?? !campaignTagged };
}
