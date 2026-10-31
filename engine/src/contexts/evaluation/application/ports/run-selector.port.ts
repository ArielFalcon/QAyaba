/* The finished runs a regrade may cover. */
export interface RunSelectorPort {
  finishedSince(sinceIso: string): string[];
  /* The campaign's finished runs. Returns one more than a regrade may cover at most, so the use case can refuse an oversized campaign. */
  ofCampaign(campaignId: string): string[];
}
