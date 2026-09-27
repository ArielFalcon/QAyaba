/* ContextMapCapturePortAdapter: fail-open write side of the FE<->BE architecture map. Never throws. */

import type { ContextMapCapturePort } from "../../application/ports/index.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
import { loadContextMapFromDisk } from "./pre-generation-grounding-port.adapter.ts";

/*
 * Persists the validated map for `app`, keyed by the deterministic run `sha` the caller supplies
 * (never the agent's own self-reported `data.builtAtSha` field, which is left untouched inside the
 * stored blob). Shell-side sink — production wires history.ts's saveContextMap here.
 */
export type ContextMapSave = (app: string, sha: string, data: ArchitectureContext) => void;

export class ContextMapCapturePortAdapter implements ContextMapCapturePort {
  constructor(
    private readonly saveFn: ContextMapSave,
    private readonly onError: (err: unknown) => void = (err) =>
      console.warn("[ContextMapCapturePortAdapter] off-path failure, swallowed:", err),
  ) {}

  async capture(specDir: string, app: string, sha: string): Promise<void> {
    try {
      /* Reuses the SAME read-validate logic PreGenerationGroundingPort's default loadContextMap
       * uses: missing/malformed/invalid all degrade to undefined (never throw, never a partial map). */
      const map = loadContextMapFromDisk(specDir);
      if (!map) return;
      this.saveFn(app, sha, map);
    } catch (err) {
      this.onError(err);
    }
  }
}
