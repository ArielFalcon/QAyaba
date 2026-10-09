/* The one reader of the files of a repository's mirror that a resolver reads for something other than the suite: the topology resolvers read the sources of every repository of a system, and the front's mirror is the agent's own working copy, with the directories the service contexts are staged into. A mirror is a directory the agent can write into, so a file in it can be a link to anywhere, a named pipe that would hold the whole single-threaded orchestrator, or as large as the disk allows. The files are listed by the one walk of the files of a repository (spec-path-confinement: no link followed, no more than a cap of entries looked at) and read one by one through the strict, capped read of the same module, which judges each again when it is opened.
   What cannot be used does not stop the resolver: a file that is refused, over its cap or unreadable is skipped, which is what a resolver does with a file it cannot parse. It is counted by why, and said once for the repository (`warn`), in words of this module's own: no file is named, since its name is the agent's to choose, and no byte of one is quoted, since a parser's message quotes what it parsed. */
import { describeReasons } from "./run-output-reader.ts";
import { REPO_WALK_LIMITS, readFailureReason, readOwnedSpecFile, walkRepoFiles, type OwnedSpecRead, type RepoWalkLimits } from "./spec-path-confinement.ts";

/* A file the walk listed and that was gone by the time it was read. */
const GONE = "it was gone when it was read";

export class RepoReader {
  private readonly reasons: string[] = [];
  private cut = false;
  private unlisted = 0;
  private odd = 0;
  private refused: string | undefined;

  constructor(
    readonly dir: string,
    private readonly limits: RepoWalkLimits = REPO_WALK_LIMITS,
  ) {}

  /* The regular files below the repository that `accept` takes (given a file's name and its path below the repository), in the order of their names. */
  files(accept: (name: string, rel: string) => boolean, skipDirs: ReadonlySet<string>): string[] {
    const walk = walkRepoFiles(this.dir, accept, skipDirs, this.limits);
    if (walk.cut) this.cut = true;
    this.unlisted += walk.unlisted;
    this.odd += walk.odd;
    if (walk.refused !== undefined) this.refused = walk.refused;
    return walk.files;
  }

  /* The text of a file the walk listed, or undefined: one that cannot be used is counted by why, and so is one that is gone. */
  listedText(rel: string, maxBytes: number): string | undefined {
    const read = this.read(rel, maxBytes);
    if (read === undefined) return undefined;
    if ("absent" in read) {
      this.reasons.push(GONE);
      return undefined;
    }
    return this.textOf(read);
  }

  /* The text of a file at a path that need not exist (a repository without an OpenAPI document is an ordinary one): one that is not there is nothing to say, and one that cannot be used is counted by why. */
  optionalText(rel: string, maxBytes: number): string | undefined {
    const read = this.read(rel, maxBytes);
    if (read === undefined || "absent" in read) return undefined;
    return this.textOf(read);
  }

  /* One line for everything left out of the repository since the last one, or nothing when nothing was. */
  warn(label: string): void {
    const parts: string[] = [];
    if (this.refused !== undefined) parts.push(`${this.refused}, so none of its files was looked at`);
    if (this.cut) parts.push(`the walk stopped at its limits (${this.limits.maxEntries} entries, ${this.limits.maxFiles} files)`);
    if (this.unlisted > 0) parts.push(`${this.unlisted} director${this.unlisted === 1 ? "y" : "ies"} could not be listed`);
    if (this.odd > 0) parts.push(`${this.odd} ${this.odd === 1 ? "entry is" : "entries are"} neither a file, a directory nor a link (a named pipe, a socket, a device) and ${this.odd === 1 ? "was" : "were"} left alone`);
    if (this.reasons.length > 0) parts.push(`${this.reasons.length} file(s) not read — ${describeReasons(this.reasons)}`);
    this.reasons.length = 0;
    this.cut = false;
    this.unlisted = 0;
    this.odd = 0;
    this.refused = undefined;
    if (parts.length > 0) console.warn(`[qa] WARNING: ${label}: ${parts.join("; ")}; what is in them is not in the result (non-blocking).`);
  }

  /* The strict read of a file of the repository, never throwing: a failure to read it is counted by its code. */
  private read(rel: string, maxBytes: number): OwnedSpecRead | undefined {
    try {
      return readOwnedSpecFile({ mirrorDir: this.dir, specDir: this.dir }, rel, maxBytes);
    } catch (err) {
      this.reasons.push(readFailureReason(err));
      return undefined;
    }
  }

  private textOf(read: { bytes: Buffer } | { reason: string }): string | undefined {
    if ("reason" in read) {
      this.reasons.push(read.reason);
      return undefined;
    }
    return read.bytes.toString("utf8");
  }
}
