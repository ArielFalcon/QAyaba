/* ReviewDomGroundingPort → captureDom. Resolves specDir + spec names into file contents, then captures against live DEV. Fail-open: captureDom already swallows render failure; unreadable specs contribute no routes. Abort unblocks via raceWithAbort — abort resolves undefined (never throws); the use-case's post-call signal?.aborted check routes abort vs ordinary grounding failure. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewDomGroundingPort } from "../../application/ports/index.ts";
import { captureDom, defaultCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { raceWithAbort } from "./abort-race.ts";

export interface ReviewDomGroundingStaticContext {
  e2eDir: string;
  baseUrl?: string; /* absent → capture() always resolves undefined */
  testIdAttribute?: string;
}

export interface ReviewDomGroundingCollaborators {
  captureDom?: typeof captureDom;
  captureDomDeps?: CaptureDomDeps;
}

export class ReviewDomGroundingPortAdapter implements ReviewDomGroundingPort {
  constructor(
    private readonly ctx: ReviewDomGroundingStaticContext,
    private readonly collaborators: ReviewDomGroundingCollaborators = {},
  ) {}

  async capture(specDir: string, specs: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    if (!this.ctx.baseUrl || specs.length === 0) return undefined;
    const specContents = specs.map((spec) => {
      try {
        return readFileSync(join(specDir, spec), "utf8");
      } catch {
        return "";
      }
    });
    const capture = this.collaborators.captureDom ?? captureDom;
    const deps = this.collaborators.captureDomDeps ?? defaultCaptureDomDeps;
    const capturePromise = capture(
      { e2eDir: this.ctx.e2eDir, baseUrl: this.ctx.baseUrl, specContents, testIdAttribute: this.ctx.testIdAttribute },
      deps,
    );
    /* captureDom does not accept AbortSignal. Racing unblocks the caller on cancel; the in-flight render finishes on its own timeout. Abort resolves undefined — never throws. */
    try {
      return await (signal ? raceWithAbort(capturePromise, signal) : capturePromise);
    } catch {
      return undefined;
    }
  }
}
