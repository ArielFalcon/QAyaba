/* Asks for a context-map rebuild and disarms the stale flag only once the queue has accepted it. A refused (""), rejected, thrown or unwired enqueue — or a run with no sha — keeps the flag armed, so the next qualifying run retries instead of the heal being lost. */
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { ContextStaleFlagPort } from "./ports/context-stale-flag.port.ts";
import type { EnqueueContextRunPort } from "./ports/enqueue-context-run.port.ts";

export class RequestContextHeal {
  constructor(
    private readonly enqueue: EnqueueContextRunPort | undefined,
    private readonly flag: ContextStaleFlagPort,
  ) {}

  execute(app: string, sha: string | undefined, parentRunId?: string): void {
    const keepArmed = (why: string): void => {
      engineLog.warn(`[qa] WARNING: context-map rebuild for ${app} not enqueued (${why}); the stale flag stays armed for the next run.`);
    };
    if (!this.enqueue) return keepArmed("no rebuild trigger is wired");
    if (!sha) return keepArmed("the run has no sha to rebuild at");
    let pending: Promise<string>;
    try {
      pending = Promise.resolve(this.enqueue({ app, sha, ...(parentRunId ? { parentRunId } : {}) }));
    } catch (err) {
      return keepArmed(err instanceof Error ? err.message : String(err));
    }
    pending.then(
      (runId) => {
        if (runId) this.flag.clear(app);
        else keepArmed("the queue refused new work");
      },
      (err: unknown) => keepArmed(err instanceof Error ? err.message : String(err)),
    );
  }
}
