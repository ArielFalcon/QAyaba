/*
 * The only place that knows which working copy a handle stands for. WorkspacePortAdapter registers the copy it checked out and
 * hands the flow a handle holding the spec directory alone; publication, confinement and gc resolve the handle back to
 * the mirror root and the commit here. A handle this registry did not issue (another run's registry, or an object the
 * caller built) is refused loudly, so no path the caller names ever reaches a git write.
 */
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";

export interface WorkspaceRecord {
  readonly mirrorDir: string;
  readonly specDir: string;
  readonly sha: string;
}

export class WorkspaceRegistry {
  private readonly records = new WeakMap<WorkspaceHandle, WorkspaceRecord>();

  register(record: WorkspaceRecord): WorkspaceHandle {
    const handle: WorkspaceHandle = Object.freeze({ specDir: record.specDir });
    this.records.set(handle, Object.freeze({ ...record }));
    return handle;
  }

  resolve(handle: WorkspaceHandle): WorkspaceRecord {
    const record = this.records.get(handle);
    if (!record) {
      throw new Error("WorkspaceRegistry: the workspace handle was not issued by this registry — refusing to act on a working copy the run was not given.");
    }
    return record;
  }
}
