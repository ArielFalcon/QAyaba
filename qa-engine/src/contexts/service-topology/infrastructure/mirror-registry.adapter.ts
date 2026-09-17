/* The path is NOT guaranteed to exist — callers (ServiceLinksPortAdapter) fs-check and fail-open per RepoRef, matching MirrorRegistryPort's own "callers should be fail-open" contract. The encoding is reached ONLY through the port method (mirrorDir) — there is no static shortcut, so every consumer goes through the SAME injected instance (DIP honored end to end). */
import { join } from "node:path";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";

export class MirrorRegistryAdapter implements MirrorRegistryPort {
  constructor(private readonly mirrorRoot: string) {}

  /** `ArielFalcon/ms-name-orders` -> `<mirrorRoot>/ArielFalcon__ms-name-orders`. Async to satisfy MirrorRegistryPort's signature; the work itself is synchronous path-joining. */
  async mirrorDir(repo: string): Promise<string> {
    return join(this.mirrorRoot, repo.replaceAll("/", "__"));
  }
}
