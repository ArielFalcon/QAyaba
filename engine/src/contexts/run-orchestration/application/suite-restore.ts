/*
 * SuiteRestorePort over the run's own spec directory: the pre-turn bytes of the files a regeneration may change.
 * A snapshot reads every file through the confined reader, so a refusal throws (a "before" that cannot be vouched
 * for must not stand in for the proven bytes); a restore writes the captured bytes back through the spec files port
 * and removes the files the turn created through the same port. The result is that the bytes on disk always
 * equal the last bytes that executed green, whatever the turn wrote in between.
 */

import { MAX_SPEC_SOURCE_BYTES, type SpecFilesPort, type SpecRoot } from "../../../shared-kernel/ports/spec-files.port.ts";
import type { SuiteRestorePoint } from "../domain/suite-restore-point.ts";
import type { SuiteRestorePort } from "./ports/suite-restore.port.ts";

/** The port bound to one run's working copy. `specDir` arguments are ignored: the root already names the directory. */
export function suiteRestorePort(root: SpecRoot, specFiles: SpecFilesPort): SuiteRestorePort {
  return {
    async snapshot(_specDir, wanted): Promise<SuiteRestorePoint> {
      const files = new Map<string, Uint8Array>();
      for (const file of wanted) {
        const read = specFiles.readOwned(root, file, MAX_SPEC_SOURCE_BYTES);
        /* A file that is not there is simply not in the snapshot: the turn may create it, and a restore then removes it. */
        if ("absent" in read) continue;
        if ("reason" in read) {
          /* A spec the run cannot read has no proof and must stop the acceptance; a support file it cannot read
             (too large, an odd entry) is left out: nothing restores it, and the run still executes what imports it. */
          if (file.endsWith(".spec.ts")) throw new Error(`${file}: ${read.reason}`);
          continue;
        }
        files.set(file, read.bytes);
      }
      return { files };
    },
    async restore(_specDir, snapshot, createdFiles): Promise<void> {
      for (const [file, bytes] of snapshot.files) {
        specFiles.write(root, file, bytes);
      }
      for (const file of createdFiles) {
        specFiles.remove(root, file);
      }
    },
  };
}
