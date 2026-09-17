/* Kills a spawned process and its descendants (process-group kill for detached children), falling back to a direct kill if the group send fails. */

import type { ChildProcess } from "node:child_process";

export interface ProcessKillPort {
  killTree(child: ChildProcess): void;
}
