/* Maps a repo identity to the absolute filesystem path of its on-disk mirror. Decoupled from the run SHA and WorkspacePort. Fail-open: the path is not guaranteed to exist on disk. */

/** Resolve a repo identity to its on-disk mirror directory (absolute path). */
export interface MirrorRegistryPort {
  mirrorDir(repo: string): Promise<string>;
}
