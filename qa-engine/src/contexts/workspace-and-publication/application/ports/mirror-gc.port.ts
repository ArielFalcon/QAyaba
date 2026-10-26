export interface MirrorGcPort {
  prune(repo: string): Promise<void>;
}
