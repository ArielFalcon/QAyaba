/* CleanupPort → orphan test-data cleanup. e2e-only. baseUrl absent → no-op (this adapter is the only place that conjunct can live without leaking baseUrl into the use-case). Collaborator never rejects by contract; the use-case still wraps the call in a non-blocking try/catch so a misbehaving collaborator never alters this run's verdict. */

import type { CleanupPort } from "../../application/ports/index.ts";

export type CleanupFn = (args: {
  dir: string;
  baseUrl: string;
  namespace: string;
  testIdAttribute?: string;
  signal?: AbortSignal;
}) => Promise<void>;

export interface CleanupPortCollaborators {
  e2e: CleanupFn;
}

export interface CleanupPortStaticContext {
  baseUrl?: string; /* absent → cleanup() is a no-op */
  testIdAttribute?: string;
}

export class CleanupPortAdapter implements CleanupPort {
  constructor(
    private readonly collaborators: CleanupPortCollaborators,
    private readonly ctx: CleanupPortStaticContext,
  ) {}

  async cleanup(specDir: string, opts: { namespace: string; signal?: AbortSignal }): Promise<void> {
    if (!this.ctx.baseUrl) return;
    await this.collaborators.e2e({
      dir: specDir,
      baseUrl: this.ctx.baseUrl,
      namespace: opts.namespace,
      ...(this.ctx.testIdAttribute !== undefined ? { testIdAttribute: this.ctx.testIdAttribute } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
}
