/*
 * Whether a context map built at one commit describes the commit a run tests (context-map-validity.ts: the files the map names are the
 * same in both commits). A map that does not fit is not used: the run grounds without it and a rebuild is requested. A page whose
 * implementation files were only modified keeps its route, and the front-to-back links of that page are dropped from the map the run
 * receives, since what the page calls may have changed. A service-triggered run's sha belongs to the service repo, so the primary
 * repo's map cannot be compared with it: that case, and a run with no sha, keep the plain sha comparison. A map's recorded commit is
 * written by the agent, so one that is not a sha is never handed to git: the map is not reused.
 */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { isCommitSha } from "@kernel/git-revision.ts";
import { contextMapValidity, type ChangedFile } from "./context-map-validity.ts";

/* The part of a map the rule reads, and the front-to-back links it may drop. */
export type FittedContextMap = Parameters<typeof contextMapValidity>[0] & { feBe: ReadonlyArray<{ route: string }> };

export type ContextMapFitReason = "none" | "sha-mismatch" | "inputs-changed";

export interface ContextMapFit<M extends FittedContextMap> {
  fits: boolean;
  /* The map the run receives: whole, without the links of the pages it cannot vouch for, or none. */
  map: M | undefined;
  reason: ContextMapFitReason;
}

export function contextMapFitsRun<M extends FittedContextMap>(
  map: M,
  capturedSha: string,
  run: { sha: string | undefined; triggeredByService: boolean },
  /* The files that differ between the map's commit and the run's, in the primary mirror; undefined when they cannot be compared. */
  changesBetween: (fromSha: string, toSha: string) => ChangedFile[] | undefined,
): ContextMapFit<M> {
  if (capturedSha === run.sha) return { fits: true, map, reason: "none" };
  if (run.triggeredByService || !run.sha) return { fits: false, map, reason: "sha-mismatch" };
  if (!isCommitSha(capturedSha)) {
    engineLog.warn(`[qa] WARNING: the context map records a commit that is not a sha (${JSON.stringify(String(capturedSha).slice(0, 40))}); it is not compared with the run's commit and the map is not reused.`);
    return { fits: false, map: undefined, reason: "sha-mismatch" };
  }
  const validity = contextMapValidity(map, capturedSha, run.sha, changesBetween(capturedSha, run.sha));
  if (!validity.valid) return { fits: false, map: undefined, reason: validity.reason === "inputs-changed" ? "inputs-changed" : "sha-mismatch" };
  if (validity.reason !== "pages-modified") return { fits: true, map, reason: "none" };
  const unverified = new Set(validity.unverifiedRoutes);
  return { fits: true, map: { ...map, feBe: map.feBe.filter((link) => !unverified.has(link.route)) }, reason: "none" };
}
