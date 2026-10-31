/**
 * What the staging of a service's context asks of the outside: a read-only git, and the file calls that list the service's mirror and
 * empty, make and write the staged directory. Both sides are directories the agent can write into, so the calls anchor on a root: the
 * front's working copy for what is staged, the service's mirror for what is read, and a link anywhere below a root is never followed.
 */
export type ServiceGitRead = (args: string[], cwd: string) => Promise<string>;

/** The bytes of a regular file, or the reason the strict read refused it (a link, a named pipe, a directory, a file over the cap). */
export type ServiceFileRead = { bytes: Buffer } | { refused: string };

export interface ServiceContextStagingPort {
  git: ServiceGitRead;
  /** Whether anything is at the path, a link to nothing included. */
  exists(path: string): boolean;
  /** Recursive (mkdir -p semantics). */
  mkdir(path: string, root: string): void;
  /** Recursive + force (rm -rf semantics). */
  rm(path: string, root: string): void;
  /** All FILES (not directories) under `dir`, recursively, as POSIX-style paths relative to `dir`. */
  listFiles(dir: string): string[];
  /** The regular file at `path` below `root`, read up to `maxBytes`; a failure that is not a refusal throws. */
  readFile(path: string, root: string, maxBytes: number): ServiceFileRead;
  writeFile(path: string, data: string | Buffer, root: string): void;
  /** Epoch millis. */
  now(): number;
}
