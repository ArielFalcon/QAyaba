/* SetupPort → e2e/code setup dispatch. Thin: maps SetupPort.setup(specDir, signal?) onto the collaborator for the run's target. A throw from either collaborator propagates verbatim — a setup failure is infra-error, never a code verdict. */
import type { SetupPort } from "../../application/ports/index.ts";
import type { TestTarget } from "@kernel/run-mode.ts";

export type SetupFn = (dir: string, opts?: { signal?: AbortSignal }) => Promise<void>;

export interface SetupPortCollaborators {
  e2e: SetupFn;
  code: SetupFn;
}

export interface SetupPortStaticContext {
  target: TestTarget;
}

export class SetupPortAdapter implements SetupPort {
  constructor(
    private readonly collaborators: SetupPortCollaborators,
    private readonly ctx: SetupPortStaticContext,
  ) {}

  async setup(specDir: string, signal?: AbortSignal): Promise<void> {
    const fn = this.ctx.target === "code" ? this.collaborators.code : this.collaborators.e2e;
    await fn(specDir, { ...(signal ? { signal } : {}) });
  }
}
