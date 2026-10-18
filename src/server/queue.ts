/*
 * Sequential job queue — one run at a time; never concurrent QA against DEV.
 * A failing job does not stop the following ones. cancel(runId) aborts only when
 * the id matches, so a stale cancel cannot abort an unrelated successor.
 */

export class JobQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private currentController: AbortController | null = null;
  private currentRunId: string | null = null;
  /* Low-priority work (LLM judges): started only when no run is pending, one at a time, on the same chain as the runs. */
  private readonly idle: Array<(signal: AbortSignal, shouldYield: () => boolean) => Promise<void>> = [];
  private idleActive = false;

  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  enqueue(job: (signal: AbortSignal) => Promise<void>, runId?: string): void {
    this.pending++;
    /* A run never waits out an idle job's call: the job is aborted (it queues what it had not finished again). */
    this.abortIdle();
    this.tail = this.tail
      .then(() => {
        this.currentController = new AbortController();
        this.currentRunId = runId ?? null;
        return job(this.currentController.signal);
      })
      .catch((e) => this.onError(e))
      .finally(() => {
        this.currentController = null;
        this.currentRunId = null;
        this.pending--;
        this.pumpIdle();
      });
  }

  /*
   * Queues low-priority work. It starts only when no run is pending, runs on the same chain as the runs (so never beside one), and is
   * not counted in `size` or `current`. A run enqueued while it runs waits for it, so the job is handed `shouldYield`: true once a run
   * is waiting, at which point it should stop at its next safe point and queue the rest again. A failing job goes to `onError`.
   */
  enqueueIdle(job: (signal: AbortSignal, shouldYield: () => boolean) => Promise<void>): void {
    this.idle.push(job);
    this.pumpIdle();
  }

  private pumpIdle(): void {
    if (this.pending > 0 || this.idleActive || this.idle.length === 0) return;
    const job = this.idle.shift()!;
    this.idleActive = true;
    this.tail = this.tail
      .then(() => {
        this.currentController = new AbortController();
        this.currentRunId = null;
        return job(this.currentController.signal, () => this.pending > 0);
      })
      .catch((e) => this.onError(e))
      .finally(() => {
        this.currentController = null;
        this.idleActive = false;
        this.pumpIdle();
      });
  }

  /* Aborts the idle job in flight, if any. */
  abortIdle(): void {
    if (this.idleActive) this.currentController?.abort();
  }

  cancel(runId?: string): boolean {
    if (!this.currentController) return false;
    if (runId !== undefined && this.currentRunId !== runId) return false;
    this.currentController.abort();
    return true;
  }

  get size(): number {
    return this.pending;
  }

  get current(): string | null {
    return this.currentRunId;
  }

  async drain(): Promise<void> {
    /* A drain wants the work that matters finished: an idle job in flight is aborted, not waited out. */
    this.abortIdle();
    await this.tail;
  }
}
