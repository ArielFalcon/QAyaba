/* ServiceLinksPort. Fail-open: a missing mirror dir is skipped (cloning is the cross-repo run's job). Empty system, empty profiles, or any thrown error degrades to { links: [], drift: [] }, logged, never propagated. A MirrorRegistryPort that rejects (not just a missing path) fails the whole resolve(), not per-service. */

import { existsSync } from "node:fs";
import type { ServiceLinksPort, ServiceLink, ContractDrift } from "../../application/ports/index.ts";
import type { RepoRef, BoundaryProfile } from "@contexts/service-topology/domain/index.ts";
import type { BoundaryProfileProviderPort } from "@contexts/service-topology/application/ports/index.ts";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";
import { buildServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/resolver-factory.ts";

export interface ServiceLinksStaticContext {
  appName: string;
  primaryRepo: string;
  services: readonly { repo: string }[];
}

export class ServiceLinksPortAdapter implements ServiceLinksPort {
  constructor(
    private readonly boundaryProfiles: BoundaryProfileProviderPort,
    private readonly mirrors: MirrorRegistryPort,
    private readonly ctx: ServiceLinksStaticContext,
  ) {}

  async resolve(): Promise<{ links: ServiceLink[]; drift: ContractDrift[] }> {
    try {
      const toRef = async (repo: string): Promise<RepoRef> => ({ repo, mirrorDir: await this.mirrors.mirrorDir(repo) });
      const front = await toRef(this.ctx.primaryRepo);
      const systemRefs = await Promise.all(this.ctx.services.map((s) => toRef(s.repo)));
      const system = systemRefs.filter((ref) => existsSync(ref.mirrorDir));
      if (system.length === 0 || !existsSync(front.mirrorDir)) return { links: [], drift: [] };

      const profiles: BoundaryProfile[] = await this.boundaryProfiles.forApp(this.ctx.appName);
      if (profiles.length === 0) return { links: [], drift: [] };

      const resolver = buildServiceBoundaryResolver(profiles);
      const result = await resolver.resolveLinks(system, front);
      /* v1: links + drift only. external/unresolved are dropped — advisory framing values precision over completeness. Plain assignment so a future field divergence fails typecheck. */
      const links: ServiceLink[] = result.links;
      const drift: ContractDrift[] = result.drift;
      return { links, drift };
    } catch (err) {
      console.error("[qa] WARNING: service-links resolve failed (non-fatal, generation continues without it):", err);
      return { links: [], drift: [] };
    }
  }
}
