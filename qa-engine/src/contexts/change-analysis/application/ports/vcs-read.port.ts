import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";

/** Typed read over a git mirror. The adapter owns argv; callers see Sha + typed results only. */
export interface VcsReadPort {
  diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string>;
  message(sha: Sha): Promise<string>;
  blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius>;
  /**
   * Other commits' messages in the full reachable `baseSha..sha` range (both merge parents), excluding `sha` itself (head comes from message(sha)). Order unspecified. [] when baseSha is absent or equals sha. Optional: omitting it is the single-commit path.
   */
  otherMessages?(sha: Sha, opts: { baseSha: Sha }): Promise<string[]>;
}
