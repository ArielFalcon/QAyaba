/* A WorkspacePort for tests: hands out a handle for a prepared working copy and resolves it back to its roots, the way the adapter does. */

import type { WorkspaceHandle, WorkspacePort } from "@contexts/workspace-and-publication/application/index.ts";

export interface FakeRoots {
  mirrorDir: string;
  specDir: string;
}

const issued = new WeakMap<WorkspaceHandle, FakeRoots>();

/* A handle for a working copy, as WorkspacePort.prepare would return it. */
export function fakeHandle(roots: FakeRoots): WorkspaceHandle {
  const handle: WorkspaceHandle = { specDir: roots.specDir };
  issued.set(handle, { mirrorDir: roots.mirrorDir, specDir: roots.specDir });
  return handle;
}

/* The roots a handle stands for; throws for a handle no fake issued. */
export function rootsOf(handle: WorkspaceHandle): FakeRoots {
  const roots = issued.get(handle);
  if (!roots) throw new Error("rootsOf: this handle was not issued by a fake workspace");
  return roots;
}

export function fakeWorkspace(roots: FakeRoots, opts: { before?: () => void | Promise<void> } = {}): WorkspacePort {
  return {
    prepare: async () => {
      await opts.before?.();
      return fakeHandle(roots);
    },
    readRoots: (workspace) => rootsOf(workspace),
  };
}
