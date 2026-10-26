/*
 * The change sets of runs that are queued and not yet started, so pushes that land while a run of the same app is waiting join
 * that run instead of queuing another (a feature landing in front and back is one run that reads both diffs).
 *
 * Every call is synchronous and the queue hands a run its turn on the same thread, so `offer` and `take` can never interleave:
 * a push either joins a run that has not been taken, or finds none and queues a run of its own. `take` is the first thing a run
 * does when its turn comes; after it the run's set is closed.
 */

import { ChangeSet, type ChangeEntry } from "@contexts/change-analysis/application/index";
import { Sha } from "@kernel/sha";
import type { RunRequest } from "./runner";

/* The repos an app declares: the entries of a change set can name no other. */
export interface DeclaredRepos {
  app: string;
  primary: string;
  services: readonly string[];
}

interface Queued {
  app: string;
  shadow: boolean | undefined;
  set: ChangeSet;
}

/*
 * Whether a request may share a run: an `e2e` diff run started by a webhook with nothing of its own to say. A manual,
 * continuation, guided, purposeful, commit-counted or per-run-overridden request, a campaign run and every code-target run
 * stay a run of their own.
 */
export function isCoalescible(req: RunRequest): boolean {
  return (
    (req.source ?? "webhook") === "webhook" &&
    (req.trigger === undefined || req.trigger === "webhook") &&
    req.mode === "diff" &&
    req.target === "e2e" &&
    req.guidance === undefined &&
    req.parentRunId === undefined &&
    req.purpose === undefined &&
    req.commits === undefined &&
    req.fixCases === undefined &&
    req.previousNamespace === undefined &&
    req.closedLoop === undefined &&
    req.agentBrowser === undefined &&
    req.grounding === undefined &&
    req.campaign === undefined &&
    req.captureMode === undefined
  );
}

/* The entry a request is: the repo it pushed, at its head, over the range its base opens (or the commit count it asked for). */
export function changeEntryOf(req: RunRequest, primaryRepo: string): ChangeEntry {
  const repo = req.triggerRepo ?? primaryRepo;
  return {
    repo,
    role: repo === primaryRepo ? "primary" : "service",
    headSha: Sha.of(req.sha),
    ...(req.baseSha ? { baseSha: Sha.of(req.baseSha) } : req.commits !== undefined ? { commits: req.commits } : {}),
  };
}

/*
 * The entry that covers both pushes of one repo: the later head over the range that starts where the earlier one did. Undefined
 * when no range can say it: a commit count has no fixed start, and two heads with no base would leave the earlier commits' diff unread.
 */
function extend(held: ChangeEntry, incoming: ChangeEntry): ChangeEntry | undefined {
  if (held.commits !== undefined || incoming.commits !== undefined) return undefined;
  const baseSha = held.baseSha ?? incoming.baseSha;
  if (!baseSha) return undefined;
  return { repo: held.repo, role: held.role, headSha: incoming.headSha, baseSha };
}

export class PendingChangeSets {
  private readonly queued = new Map<string, Queued>();

  /* Records the set of a run that was just queued. A request that cannot share a run is not recorded. */
  register(runId: string, req: RunRequest, declared: DeclaredRepos): void {
    if (!isCoalescible(req)) return;
    this.queued.set(runId, { app: declared.app, shadow: req.shadow, set: ChangeSet.of(declared.app, [changeEntryOf(req, declared.primary)]) });
  }

  /* Joins the push to the latest queued run of its app and returns that run's id; undefined when no queued run can take it. */
  offer(req: RunRequest, declared: DeclaredRepos, isQueued: (runId: string) => boolean): string | undefined {
    if (!isCoalescible(req)) return undefined;
    const entry = changeEntryOf(req, declared.primary);
    if (entry.repo !== declared.primary && !declared.services.includes(entry.repo)) return undefined;
    let target: [string, Queued] | undefined;
    for (const candidate of this.queued) {
      if (candidate[1].app === declared.app && candidate[1].shadow === req.shadow && isQueued(candidate[0])) target = candidate;
    }
    if (!target) return undefined;
    const [runId, held] = target;
    const existing = held.set.entries.find((e) => e.repo === entry.repo);
    const merged = existing ? extend(existing, entry) : entry;
    if (!merged) return undefined;
    const entries = existing ? held.set.entries.map((e) => (e === existing ? merged : e)) : [...held.set.entries, merged];
    this.queued.set(runId, { ...held, set: ChangeSet.of(held.set.app, entries) });
    return runId;
  }

  /* Closes the run's set and returns it: a push that arrives later queues a run of its own. */
  take(runId: string): ChangeSet | undefined {
    const held = this.queued.get(runId);
    this.queued.delete(runId);
    return held?.set;
  }
}
