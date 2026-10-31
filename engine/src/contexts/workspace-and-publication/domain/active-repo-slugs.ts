/* The repos a mirror-pruning pass must never touch: those of the run history says is running, plus, defensively, since the database and the queue can be momentarily out of sync, those of the run the queue says it is executing. */

/* Directory name of a repo's mirror under the mirrors root. */
export function repoSlug(repo: string): string {
  return repo.replaceAll("/", "__");
}

export interface ActiveRunLookups {
  /** The running/enqueued record from history. */
  currentRun(): { id: string; status: string; app: string; triggerRepo?: string } | undefined;
  /** The run id the queue is executing right now. */
  queueCurrentRunId(): string | null;
  getRecord(id: string): { app: string; triggerRepo?: string } | undefined;
  /** Primary repo of an app's config, or undefined when the config is missing/malformed. */
  repoForApp(app: string): string | undefined;
}

export function computeActiveRepoSlugs(lookups: ActiveRunLookups): Set<string> {
  const slugs = new Set<string>();
  const add = (app: string, triggerRepo?: string) => {
    const repo = lookups.repoForApp(app);
    if (repo) slugs.add(repoSlug(repo));
    if (triggerRepo) slugs.add(repoSlug(triggerRepo));
  };
  const running = lookups.currentRun();
  if (running && running.status === "running") add(running.app, running.triggerRepo);
  const queueId = lookups.queueCurrentRunId();
  if (queueId && (!running || running.id !== queueId)) {
    const record = lookups.getRecord(queueId);
    if (record) add(record.app, record.triggerRepo);
  }
  return slugs;
}
