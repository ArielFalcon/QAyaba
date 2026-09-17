/* PreExecGroundingPort: read spec sources and capture route trees. Never throws; abort resolves empty. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreExecGroundingPort } from "../../application/ports/index.ts";
import { captureRouteTrees, defaultCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { buildRouteCatalog } from "@contexts/generation/infrastructure/route-catalog.ts";
import { enumerateExistingSpecFiles } from "./pre-generation-grounding-port.adapter.ts";
import { raceWithAbort, isAbortError } from "./abort-race.ts";

/* One captured route: `nodes` required; `status`/`settled`/`testIds` from buildRouteCatalog, not the raw capture. */
type CapturedRoute = Awaited<ReturnType<PreExecGroundingPort["capture"]>>["routes"][number];

export interface PreExecGroundingStaticContext {
  e2eDir: string; /* absolute path to the seeded e2e project (mirrors CaptureDomInput.e2eDir) */
  baseUrl?: string; /* live DEV base URL — absent -> captureRouteTrees always resolves [] */
  testIdAttribute?: string; /* config-declared convention (e.g. "data-cy") */
}

export interface PreExecGroundingCollaborators {
  captureRouteTrees?: typeof captureRouteTrees;
  captureDomDeps?: CaptureDomDeps;
}

export class PreExecGroundingPortAdapter implements PreExecGroundingPort {
  constructor(
    private readonly ctx: PreExecGroundingStaticContext,
    private readonly collaborators: PreExecGroundingCollaborators = {},
  ) {}

  async capture(specDir: string, signal?: AbortSignal): Promise<{ specSources: string[]; routes: CapturedRoute[] }> {
    /* Already-aborted signal skips the fs read and the capture. Never throw — resolve empty. */
    if (signal?.aborted) return { specSources: [], routes: [] };

    const specFiles = enumerateExistingSpecFiles(specDir);
    const specSources = specFiles.map((spec) => {
      try {
        return readFileSync(join(specDir, spec), "utf8");
      } catch {
        return ""; /* unreadable spec contributes no routes/text */
      }
    });

    if (specSources.length === 0 || !this.ctx.baseUrl) return { specSources, routes: [] };

    const capture = this.collaborators.captureRouteTrees ?? captureRouteTrees;
    const deps = this.collaborators.captureDomDeps ?? defaultCaptureDomDeps;
    const capturePromise = capture(
      { e2eDir: this.ctx.e2eDir, baseUrl: this.ctx.baseUrl, specContents: specSources, testIdAttribute: this.ctx.testIdAttribute },
      deps,
    );
    /* captureRouteTrees does not accept AbortSignal. Racing unblocks the caller; the in-flight render keeps running to its own timeout. This port never throws — abort resolves specSources already read plus empty routes[]; the use-case routes abort after this call. */
    try {
      const snapshots = await (signal ? raceWithAbort(capturePromise, signal) : capturePromise);
      /* Adapt the raw RouteSnapshot[] into the port's CapturedRoute shape: `nodes` defaults to [] (RouteSnapshot.nodes is optional pre-catalog; the port requires it), `status`/`settled`/ `testIds` are sourced from buildRouteCatalog (the Pillar-2 confidence derivation this port's own doc names — "A real adapter... wraps generation/infrastructure's captureRouteTrees + buildRouteCatalog", ports/index.ts:479-480), never the raw capture fields directly. */
      const routes: CapturedRoute[] = snapshots.map((snap) => {
        const catalog = buildRouteCatalog(snap);
        return {
          route: catalog.route,
          nodes: snap.nodes ?? [],
          status: catalog.status,
          settled: catalog.settled,
          testIds: catalog.testIds,
        };
      });
      return { specSources, routes };
    } catch (err) {
      if (isAbortError(err)) return { specSources, routes: [] };
      /* captureRouteTrees itself already degrades a render failure to [] with its own console.warn (dom-snapshot.ts's own header) — this catch is a defensive backstop only, matching ReviewDomGroundingPortAdapter's own posture of never letting ANY throw escape this bridge. */
      console.warn(`[qa] WARNING: pre-exec route capture FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return { specSources, routes: [] };
    }
  }
}
