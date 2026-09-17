import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";

export class StubMirrorRegistryAdapter implements MirrorRegistryPort {
  /** Returns a deterministic stub path: /mirrors/{org}/{repo}. The path is NOT guaranteed to exist. Callers must be fail-open. */
  async mirrorDir(repo: string): Promise<string> {
    return `/mirrors/${repo}`;
  }
}
