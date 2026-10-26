import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";

export interface ManifestRepositoryPort {
  read(specDir: string): Promise<ManifestEntry[]>;
  /* The entries' files are the names the agent reported, relative to `root.specDir`: they are resolved against the whole root, so one that leaves it is a phantom like one that is not on disk. */
  reconcile(root: SpecRoot, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}
