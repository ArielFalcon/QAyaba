/* ContextMapCapturePortAdapter: fail-open write side of the FE<->BE architecture map. Never throws, except for an untrusted git dir (UntrustedGitTreeError), which is a security refusal. */

import { rethrowIfUntrusted } from "@kernel/domain-error.ts";
import type { ContextMapCapturePort } from "../../application/ports/index.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
import { loadContextMapFromDisk } from "./pre-generation-grounding-port.adapter.ts";

/*
 * Persists the validated map for `app`, keyed by the deterministic run `sha` the caller supplies
 * (never the agent's own self-reported `data.builtAtSha` field, which is left untouched inside the
 * stored blob). Shell-side sink — production wires history.ts's saveContextMap here.
 */
export type ContextMapSave = (app: string, sha: string, data: ArchitectureContext) => void;

/*
 * Whether this run wrote `specDir`'s .qa/context.json: it differs from the run's base commit (added,
 * modified, untracked or ignored). A committed map the run left untouched is not a fresh one — it
 * may be the very map the process audit condemned. Throws when it cannot tell.
 */
export type ContextMapWrittenThisRun = (specDir: string) => boolean;

export class ContextMapCapturePortAdapter implements ContextMapCapturePort {
  constructor(
    private readonly saveFn: ContextMapSave,
    private readonly writtenThisRun: ContextMapWrittenThisRun,
    private readonly onError: (err: unknown) => void = (err) =>
      console.warn("[ContextMapCapturePortAdapter] off-path failure, swallowed:", err),
  ) {}

  async capture(specDir: string, app: string, sha: string): Promise<void> {
    try {
      if (!this.writtenThisRun(specDir)) return;
      /* Reuses the SAME read-validate logic PreGenerationGroundingPort's default loadContextMap
       * uses: missing/malformed/invalid all degrade to undefined (never throw, never a partial map). */
      const map = loadContextMapFromDisk(specDir);
      if (!map) return;
      this.saveFn(app, sha, map);
    } catch (err) {
      rethrowIfUntrusted(err); /* a git dir that is not the orchestrator's is a security refusal, not an off-path failure */
      this.onError(err);
    }
  }
}
