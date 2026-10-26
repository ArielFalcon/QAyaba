/* Builds the service-topology context: the service links of an app, the cross-repo impact over the declared mirrors, and the pages a change reaches over the run's call graph. */

import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import type { BoundaryProfileProviderPort, ChangePagesPort, CrossRepoImpactPort, CrossRepoVcsRead, ServiceLinksPort } from "../application/index.ts";
import { ChangePagesPortAdapter, type ChangePagesPortAdapterDeps } from "../infrastructure/adapters/change-pages-port.adapter.ts";
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
  /* The change's pages over the run's call graph. Absent: none are found. */
  pages?: ChangePagesPortAdapterDeps;
}

export interface ServiceTopologyApi {
  serviceLinks?: ServiceLinksPort;
  crossRepoImpact?: CrossRepoImpactPort;
  changePages?: ChangePagesPort;
}

export function buildServiceTopology(deps: ServiceTopologyDeps): ServiceTopologyApi {
  const { links, impact, pages } = deps;
  return {
    ...(links
      ? {
          serviceLinks: new ServiceLinksPortAdapter(links.boundaryProfiles, new MirrorRegistryAdapter(links.mirrorRoot), {
            appName: links.appName,
            primaryRepo: links.primaryRepo,
            services: links.services,
          }),
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
    ...(pages ? { changePages: new ChangePagesPortAdapter(pages) } : {}),
  };
}
