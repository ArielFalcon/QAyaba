import type { RepoRef } from "../../domain/index.ts";
import type { ResolveLinksResult } from "../../domain/service-boundary-resolver.ts";

/** Cross-service boundary resolution port. Each adapter is a transport strategy (OpenAPI, gRPC, events). */
export interface ServiceBoundaryResolverPort {
  /** Resolve cross-service links for the given system (backend repos) and frontend repo. NEVER throws: any error degrades to an empty ResolveLinksResult. */
  resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult>;
}
