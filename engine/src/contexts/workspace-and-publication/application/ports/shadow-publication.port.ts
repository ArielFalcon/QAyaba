export interface ShadowPublicationPort {
  openPr(repo: string, branch: string, title: string, body: string): Promise<void>;
  openIssue(repo: string, title: string, body: string): Promise<void>;
  commit(dir: string, message: string, files: readonly string[]): Promise<void>;
  push(dir: string, branch: string): Promise<void>;
  prune(mirrorDir: string): Promise<void>;
}
