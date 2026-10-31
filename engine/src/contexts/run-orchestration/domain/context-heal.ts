/* When a run asks for the stored context map to be rebuilt. A rebuild is a `mode: context` run of its own, so a run that is itself the rebuild never asks for one, and a frozen run (a campaign replicate) leaves the rebuild for after the campaign. */
import type { RunMode } from "@kernel/run-mode.ts";

/* `request`: ask for a rebuild at the run's commit; `withhold`: the run would ask but is frozen or has already asked; `none`: nothing condemns the map. */
export type ContextHealAction = "none" | "request" | "withhold";

/*
 * The process audit's context_stale flag condemns the stored map as a whole. Only a primary-repo run that is not itself the rebuild reads it:
 * a context-mode run IS the rebuild, and a service-triggered run's sha belongs to the service repo, not the primary. `flagged` is asked only
 * of a run that qualifies.
 */
export function staleFlagHeal(run: { mode: RunMode; triggeredByService: boolean; frozen: boolean }, flagged: () => boolean): ContextHealAction {
  if (run.mode === "context" || run.triggeredByService) return "none";
  if (!flagged()) return "none";
  return run.frozen ? "withhold" : "request";
}

/* A map stale by commit or age is rebuilt off the audit's path, once per app and commit; a context run never asks and the flag is left as it was. */
export function staleMapHeal(run: { mode: RunMode; frozen: boolean }, map: { stale?: boolean | undefined } | undefined, alreadyAsked: boolean): ContextHealAction {
  if (!map?.stale || run.mode === "context") return "none";
  return run.frozen || alreadyAsked ? "withhold" : "request";
}
