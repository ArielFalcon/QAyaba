/* SpecFilesPort over the confined reader: each method is the matching function of spec-path-confinement.ts, called with its defaults. */

import type { SpecFilesPort } from "../shared-kernel/ports/spec-files.port.ts";
import { listSpecFiles, listSuiteFiles, probeOwnedSpecFile, readConfinedSpecFile, readOwnedSpecFile, removeOwnedSpecFile, writeOwnedSpecFile } from "./spec-path-confinement.ts";

export const confinedSpecFiles: SpecFilesPort = {
  list: (dir) => listSpecFiles(dir),
  listSuite: (dir) => listSuiteFiles(dir),
  read: (root, reported, maxBytes) => readConfinedSpecFile(root, reported, maxBytes),
  readOwned: (root, rel, maxBytes) => readOwnedSpecFile(root, rel, maxBytes),
  write: (root, rel, content) => writeOwnedSpecFile(root, rel, content),
  remove: (root, rel) => removeOwnedSpecFile(root, rel),
  probe: (root, rel) => probeOwnedSpecFile(root, rel),
};
