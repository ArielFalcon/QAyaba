/*
 * Operator switch, OFF by default, for an A/B campaign (docs/efficiency-benchmark.md, "Campaigns"): the pipeline
 * learns from every run (rule fold and retrieval, curriculum, reflector, process audit with its incidents and its
 * context-stale flag), so a replicate would start from what the previous one left and the replicates would not be
 * comparable. With the switch on, a run reads none of that state and writes none of it.
 * Read once by the composition root; the engine never reads the environment. A mistyped value throws, as the
 * other operator switches do.
 */
export const CAMPAIGN_FREEZE_ENV = "QA_CAMPAIGN_FREEZE";

export function resolveCampaignFreeze(env: Record<string, string | undefined>): boolean {
  const raw = (env[CAMPAIGN_FREEZE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new Error(`${CAMPAIGN_FREEZE_ENV} must be 1, true, 0, false or empty, got ${JSON.stringify(env[CAMPAIGN_FREEZE_ENV])}`);
}
