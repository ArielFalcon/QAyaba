import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type { RepoRef } from "../domain/index.ts";

export class StubServiceBoundaryResolver implements ServiceBoundaryResolverPort {
  async resolveLinks(_system: RepoRef[], _front: RepoRef): Promise<ResolveLinksResult> {
    return { links: [], drift: [], external: [], unresolved: [] };
  }
}
