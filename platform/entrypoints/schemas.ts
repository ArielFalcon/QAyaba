import { z } from "zod";
import { RunModeSchema } from "../../engine/src/shared-kernel/contract/events";

export { ManifestEntrySchema, ManifestSchema } from "../../engine/src/shared-kernel/manifest/manifest-entry";
export type { ManifestEntry as ValidatedManifestEntry } from "../../engine/src/shared-kernel/manifest/manifest-entry";

/*
 * ── Webhook payload schema ────────────────────────────────────────────────────
 * Validates the incoming POST body from GitHub / manual triggers.
 */
export const WebhookPayloadSchema = z.object({
  repo: z.string().min(1),
  sha: z.string().min(7),
  mode: RunModeSchema.optional(),
  guidance: z.string().optional(),
});
