export interface MirrorEntry {
  name: string;  /* directory name (the repo slug) */
  path: string;  /* absolute path */
  mtimeMs: number;  /* last modification time */
}

/** The mirrors root as the pruning pass sees it. */
export interface MirrorStorePort {
  /** Directories under the mirrors root (non-directories excluded). May throw if the root is unreadable. */
  listMirrorDirs(root: string): MirrorEntry[];
  remove(path: string): void;
  directorySize(path: string): number;
}
