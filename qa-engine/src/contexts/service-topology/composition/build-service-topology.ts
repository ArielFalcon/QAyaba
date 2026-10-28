/* Builds the service-topology context: the service links of an app, the cross-repo impact over the declared mirrors. */

import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import type { BoundaryProfileProviderPort, CrossRepoImpactPort, CrossRepoVcsRead, ProviderDocumentsPort, ServiceLinksPort } from "../application/index.ts";
import { ProviderDocumentsPortAdapter } from "../infrastructure/adapters/provider-documents-port.adapter.ts";
import { CrossRepoImpactPortAdapter } from "../infrastructure/adapters/cross-repo-impact-port.adapter.ts";
import { ServiceLinksPortAdapter } from "../infrastructure/adapters/service-links-port.adapter.ts";
import { MirrorRegistryAdapter } from "../infrastructure/mirror-registry.adapter.ts";

export interface ServiceTopologyDeps {
  /* The app's declared services. Absent: the run has no links. */
  links?: {
    appName: string;
    primaryRepo: string;
    mirrorRoot: string;
    services: readonly { repo: string }[];
    boundaryProfiles: BoundaryProfileProviderPort;
  };
  /* Cross-repo impact over the same mirrors. Absent: none is answered. */
  impact?: {
    mirrorRoot: string;
    runner: SandboxedBinaryRunner;
    /* Reads one mirror's history. */
    makeVcs: (repoDir: string) => CrossRepoVcsRead;
    /* The tier that reads the call graph. Absent: the graph answers nothing. */
    codeGraph?: CodeGraphPort;
  };
}

export interface ServiceTopologyApi {
  serviceLinks?: ServiceLinksPort;
  /* The documents the resolved links point at, for whoever classifies a field by the provider's contract. Present with the links. */
  providerDocuments?: ProviderDocumentsPort;
  crossRepoImpact?: CrossRepoImpactPort;
}

export function buildServiceTopology(deps: ServiceTopologyDeps): ServiceTopologyApi {
  const { links, impact } = deps;
  return {
    ...(links
      ? {
          serviceLinks: new ServiceLinksPortAdapter(links.boundaryProfiles, new MirrorRegistryAdapter(links.mirrorRoot), {
            appName: links.appName,
            primaryRepo: links.primaryRepo,
            services: links.services,
          }),
          providerDocuments: new ProviderDocumentsPortAdapter(new MirrorRegistryAdapter(links.mirrorRoot), links.services),
        }
      : {}),
    ...(impact
      ? {
          crossRepoImpact: new CrossRepoImpactPortAdapter({
            mirrors: new MirrorRegistryAdapter(impact.mirrorRoot),
            makeVcs: impact.makeVcs,
            ...(impact.codeGraph ? { codeGraph: impact.codeGraph } : {}),
            /* The same runner: no extra spawn surface. */
            runner: impact.runner,
          }),
        }
      : {}),
  };
}
