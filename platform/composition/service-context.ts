/*
 * The real file and git calls the staging of a service's context (service-topology's stageServiceContext) runs on. Both sides are
 * directories the agent can write into — the service's mirror and the front's working copy the context is staged into — so every path
 * is below a root and goes through the strict, capped calls of spec-path-confinement: a link is never followed and a named pipe never
 * opened. The staging directory is emptied, made and written through the strict calls rooted at the working copy, so nothing is made or
 * written through a link the agent planted in it.
 */

import { dirname, relative, sep } from "node:path";
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { realGit } from "./repo-mirror";
import type { ServiceContextStagingPort } from "@contexts/service-topology/application/index";
import { ensureOwnedSpecDir, readOwnedSpecFile, writeOwnedSpecFile, type SpecRoot } from "../../qa-engine/src/shared-infrastructure/spec-path-confinement";
import { RepoReader } from "../../qa-engine/src/shared-infrastructure/repo-reader";

/*
 * Excludes VCS internals and installed deps from the default sweep's directory walk — mirrors
 * getDirectorySize's own recursive-walk precedent (workspace-and-publication's mirror-fs.adapter.ts). The walk is the one walk of
 * the files of a repository (spec-path-confinement): it follows no link, opens no named pipe,
 * looks at no more than a cap of entries and visits them in the order of their names; what it
 * could not walk is said once for the service, naming no file.
 */
/* mutation-scope:begin sweep-skip-dirs */
const SWEEP_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

const strictRoot = (root: string): SpecRoot => ({ mirrorDir: root, specDir: root });
const below = (root: string, path: string): string => relative(root, path).split(sep).join("/");

/* Whether anything is at the path, a link to nothing included: a path that is followed is not there when it leads nowhere, so a link to nothing at the staging directory would be neither removed nor made, and would fail every later staging. */
const somethingAt = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export const defaultStageDeps: ServiceContextStagingPort = {
  git: realGit,
  exists: somethingAt,
  mkdir: (path, root) => ensureOwnedSpecDir(strictRoot(root), below(root, path)),
  rm: (path, root) => {
    /* The path to what is removed must be ordinary directories of the working copy: a removal through a link the agent planted above it would remove what the link points at. What is at the path itself is removed as it is, a link as a link. */
    ensureOwnedSpecDir(strictRoot(root), below(root, dirname(path)));
    /* A link is unlinked by name: `rmSync` resolves the path it is given, so on some runtimes it leaves a link to nothing standing and refuses a link to a directory. */
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path);
    else rmSync(path, { recursive: true, force: true });
  },
  listFiles: (dir) => {
    const reader = new RepoReader(dir);
    const files = reader.files(() => true, SWEEP_SKIP_DIRS);
    reader.warn(dir);
    return files;
  },
  readFile: (path, root, maxBytes) => {
    const read = readOwnedSpecFile(strictRoot(root), below(root, path), maxBytes);
    if ("bytes" in read) return { bytes: read.bytes };
    return { refused: "reason" in read ? read.reason : "the file is not there" };
  },
/* mutation-scope:end sweep-skip-dirs */
  writeFile: (path, data, root) => writeOwnedSpecFile(strictRoot(root), below(root, path), data),
  now: () => Date.now(),
};
