/* Manifest I/O via injected fns (no disk in test). Reconcile: ids unique, every entry maps to an on-disk spec. */
import type { ManifestRepositoryPort, ManifestEntry } from "../application/ports/index.ts";
import type { SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";

export interface ManifestFns {
  readManifest(specDir: string): Promise<ManifestEntry[]>;
  reconcileManifest(root: SpecRoot, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}

export class ManifestRepositoryAdapter implements ManifestRepositoryPort {
  constructor(private readonly fns: ManifestFns) {}

  read(specDir: string): Promise<ManifestEntry[]> {
    return this.fns.readManifest(specDir);
  }

  reconcile(root: SpecRoot, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
    return this.fns.reconcileManifest(root, entries);
  }
}
