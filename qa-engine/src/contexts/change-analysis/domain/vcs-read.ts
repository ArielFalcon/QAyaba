import type { Sha } from "@kernel/sha.ts";

export interface ExtractionContext {
  sha: Sha;
  baseSha?: Sha;
  repoDir: string;
  changedFiles: string[];
  diff: string;
}
