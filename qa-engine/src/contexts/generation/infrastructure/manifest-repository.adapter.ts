/* Manifest I/O via injected fns (no disk in test). Reconcile: ids unique, every entry maps to an on-disk spec. */
import type { ManifestRepositoryPort, ManifestEntry } from "../application/ports/index.ts";

export interface ManifestFns {
  readManifest(specDir: string): Promise<ManifestEntry[]>;
  reconcileManifest(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}

export class ManifestRepositoryAdapter implements ManifestRepositoryPort {
  constructor(private readonly fns: ManifestFns) {}

  read(specDir: string): Promise<ManifestEntry[]> {
    return this.fns.readManifest(specDir);
  }

  reconcile(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
    return this.fns.reconcileManifest(specDir, entries);
  }
}
