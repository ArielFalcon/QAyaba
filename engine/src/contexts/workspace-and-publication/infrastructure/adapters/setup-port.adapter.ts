/* SetupPort → the e2e setup collaborator. Thin: maps SetupPort.setup(specDir, signal?) onto it. A throw from the collaborator propagates verbatim — a setup failure is infra-error, never a test verdict. */
import type { SetupPort } from "../../application/ports/setup.port.ts";

export type SetupFn = (dir: string, opts?: { signal?: AbortSignal }) => Promise<void>;

export interface SetupPortCollaborators {
  e2e: SetupFn;
}

export class SetupPortAdapter implements SetupPort {
  constructor(private readonly collaborators: SetupPortCollaborators) {}

  async setup(specDir: string, signal?: AbortSignal): Promise<void> {
    const fn = this.collaborators.e2e;
    await fn(specDir, { ...(signal ? { signal } : {}) });
  }
}
