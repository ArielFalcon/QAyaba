/*
 * The identity of a campaign replicate, as a request names it and a run records it. The labels are data: nothing in the engine reads
 * them to decide what to do (docs/observability-design.md section 14), only the explicit levers and the deployment's configuration do.
 */

export const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
export const CAMPAIGN_LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_VARIANT_KEYS = 16;
export const MAX_CAMPAIGN_REPLICATE = 1000;

export interface CampaignIdentity {
  readonly id: string;
  readonly variant: Readonly<Record<string, string>>;
  readonly replicate: number;
}
