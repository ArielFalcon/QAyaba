/*
 * The reference set of use cases: for a change an app deployed, the use cases its code introduces, written by a person who read the
 * diff, each with whether a browser test can reach it on the live site. It is the ground truth a person labels a run against (did the
 * run's specs cover every reachable use case?), and the labels are what calibrates the `use_case_coverage` judge. The set is user data
 * (`config/benchmarks/use-cases/<app>.json`); the tracked example documents the format. Pure.
 */

/*
 * How a use case can be reached by a browser test against the live site:
 *  - `dev`: through the UI with the site's real data.
 *  - `fault-injection`: only when a request fails or the server answers an error the site gives no way to provoke (the generators may
 *    not mock the network, so a run cannot reach it).
 *  - `not-observable`: it would be visible, but the deployed site does not show it (a server status a client-rendered site never sends,
 *    data the environment does not hold).
 *  - `not-e2e`: it has no effect a browser sees (a native platform, logic with no rendered result).
 */
export const REACHABILITY = ["dev", "fault-injection", "not-observable", "not-e2e"] as const;
export type Reachability = (typeof REACHABILITY)[number];

export interface ReferenceUseCase {
  id: string;
  description: string;
  reachability: Reachability;
  /* The app's pages the use case shows on, as the app's map names them; empty when it is on none. */
  routes: string[];
  /* Why it is not reachable on `dev`, when it is not. */
  why?: string;
}

export interface ReferenceChange {
  sha: string;
  /* The commit the change is measured from, when it spans more than one commit. */
  base?: string;
  summary: string;
  useCases: ReferenceUseCase[];
}

export interface UseCaseReference {
  app: string;
  changes: ReferenceChange[];
}

const SHA = /^[0-9a-f]{7,40}$/;
/* A short sha names a commit only from this length on. */
const MIN_SHA_CHARS = 7;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function useCaseOf(value: unknown, where: string): ReferenceUseCase {
  if (!isRecord(value)) throw new Error(`${where}: a use case is an object`);
  if (!nonEmpty(value.id)) throw new Error(`${where}: id is required`);
  if (!nonEmpty(value.description)) throw new Error(`${where} ${value.id}: description is required`);
  if (!REACHABILITY.includes(value.reachability as Reachability)) throw new Error(`${where} ${value.id}: reachability is one of ${REACHABILITY.join(", ")}`);
  const routes = value.routes === undefined ? [] : value.routes;
  if (!Array.isArray(routes) || !routes.every((r) => typeof r === "string" && r.startsWith("/"))) throw new Error(`${where} ${value.id}: routes is a list of paths`);
  if (value.reachability !== "dev" && !nonEmpty(value.why)) throw new Error(`${where} ${value.id}: a use case not reachable on dev says why`);
  return {
    id: value.id,
    description: value.description,
    reachability: value.reachability as Reachability,
    routes: [...routes] as string[],
    ...(nonEmpty(value.why) ? { why: value.why } : {}),
  };
}

function changeOf(value: unknown, where: string): ReferenceChange {
  if (!isRecord(value)) throw new Error(`${where}: a change is an object`);
  if (typeof value.sha !== "string" || !SHA.test(value.sha)) throw new Error(`${where}: sha is a commit id of at least ${MIN_SHA_CHARS} hex characters`);
  if (value.base !== undefined && (typeof value.base !== "string" || !SHA.test(value.base))) throw new Error(`${where} ${value.sha}: base is a commit id`);
  if (!nonEmpty(value.summary)) throw new Error(`${where} ${value.sha}: summary is required`);
  if (!Array.isArray(value.useCases)) throw new Error(`${where} ${value.sha}: useCases is a list (empty for a change with none)`);
  const useCases = value.useCases.map((u, i) => useCaseOf(u, `${where} ${value.sha} useCases[${i}]`));
  if (new Set(useCases.map((u) => u.id)).size !== useCases.length) throw new Error(`${where} ${value.sha}: use case ids are unique`);
  return { sha: value.sha, ...(typeof value.base === "string" ? { base: value.base } : {}), summary: value.summary, useCases };
}

/** The reference set a file holds, or an error naming the first thing wrong with it. */
export function parseUseCaseReference(raw: unknown, name: string): UseCaseReference {
  if (!isRecord(raw)) throw new Error(`${name}: the reference set is an object`);
  if (!nonEmpty(raw.app)) throw new Error(`${name}: app is required`);
  if (!Array.isArray(raw.changes)) throw new Error(`${name}: changes is a list`);
  const changes = raw.changes.map((c, i) => changeOf(c, `${name} changes[${i}]`));
  return { app: raw.app, changes };
}

/** The change of `app` a run of commit `sha` measures, or undefined. Shas are compared on the shorter of the two, from MIN_SHA_CHARS on. */
export function referenceFor(sets: readonly UseCaseReference[], app: string, sha: string): ReferenceChange | undefined {
  const same = (a: string, b: string): boolean => Math.min(a.length, b.length) >= MIN_SHA_CHARS && (a.startsWith(b) || b.startsWith(a));
  return sets.filter((s) => s.app === app).flatMap((s) => s.changes).find((c) => same(c.sha.toLowerCase(), sha.toLowerCase()));
}
