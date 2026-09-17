/* Last SHA at which a mirror's code graph was successfully synced. Keyed by mirrorDir so two watched repos never share a cursor. Absent/unreadable state is undefined (fail-open) — SHA skip vs reindex is a RunQaUseCase concern, not this port. */

export interface IndexStatusPort {
  getLastIndexedSha(mirrorDir: string): Promise<string | undefined>;
  setLastIndexedSha(mirrorDir: string, sha: string): Promise<void>;
}
