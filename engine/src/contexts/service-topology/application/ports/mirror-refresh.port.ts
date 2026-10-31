/* Brings a mirror up to date with its remote before its diff is read. Best effort: a failed refresh leaves whatever is already on disk, and the caller reads that. */
export interface MirrorRefreshPort {
  refresh(mirrorDir: string): Promise<void>;
}
