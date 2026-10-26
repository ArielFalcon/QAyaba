/* The one way a use case reads, lists, writes or removes a file below a run's spec directory. The agent writes that directory and names files in it, so every path here is untrusted input: an implementation refuses a path that leaves the directory, a link, a named pipe and anything over the size cap. The implementation is the confined reader in shared-infrastructure; no use case reaches it any other way. */

/* A spec, a fixtures file, a login script or a config file is source a person would read; one larger than this is not read. */
export const MAX_SPEC_SOURCE_BYTES = 256 * 1024;

/* Where the specs of a run live and the checkout that holds them. For a code run the two are the same directory. */
export interface SpecRoot {
  mirrorDir: string;
  specDir: string;
}

/* The bytes of a file the orchestrator keeps, absent when it or a directory above it is not there, or the reason the read was refused. */
export type OwnedSpecRead = { bytes: Buffer } | { absent: true } | { reason: string };

/* Every regular file below a directory, relative to it. `cut` is true when the walk looked at fewer entries than the directory holds, so the list is not the whole suite. */
export interface SuiteFiles {
  files: string[];
  cut: boolean;
}

/* What a removal or a purge did: the entry it took away and how, or that nothing was there. */
export type PurgeResult = { removed: string; how: "unlinked" | "set aside" } | { nothing: true };

export interface SpecFilesPort {
  /** Every `*.spec.ts` below a directory, relative to it, without following a link. */
  list(dir: string): string[];
  /** Every regular file below a directory (specs and the support files they import), relative to it. */
  listSuite(dir: string): SuiteFiles;
  /** The text of a file an agent reported, whole or not at all. Throws when the path is refused or the file is larger than `maxBytes`. */
  read(root: SpecRoot, reported: string, maxBytes?: number): string;
  /** A file the orchestrator keeps at `rel`, read strictly. */
  readOwned(root: SpecRoot, rel: string, maxBytes: number): OwnedSpecRead;
  /** Replaces the file at `rel` through a temporary file renamed over the target, never through a link. Throws when the path is refused. */
  write(root: SpecRoot, rel: string, content: string | Uint8Array): void;
  /** Removes the entry at `rel` without opening or following it. Throws when the path is refused. */
  remove(root: SpecRoot, rel: string): PurgeResult;
  /** Whether a regular file is at `rel`, judged like a strict read but without opening it. */
  probe(root: SpecRoot, rel: string): "file" | "absent" | { reason: string };
}
