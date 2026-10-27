/*
 * Within a campaign every arm captures the same content (docs/observability-design.md sections 9.2 and 14): a run that joined with a
 * different capture mode would make the arms differ in what their traces hold, and a caller could smuggle a richer export into one arm.
 * The mode compared is the APPLIED one, after the server's ceiling.
 */
import type { CaptureMode } from "@kernel/telemetry/capture-mode";

export class CampaignCaptureMismatchError extends Error {
  constructor(
    readonly campaignId: string,
    readonly expected: string,
    readonly applied: CaptureMode,
  ) {
    super(`campaign '${campaignId}' captures with mode '${expected}', but this run's applied capture mode is '${applied}': every run of a campaign must use the same mode (send captureMode '${expected}' or none)`);
  }
}

/* Throws when the campaign already has runs whose capture mode differs from the one this run would apply. */
export function assertUniformCapture(campaignId: string, applied: CaptureMode, existing: string | undefined): void {
  if (existing !== undefined && existing !== applied) throw new CampaignCaptureMismatchError(campaignId, existing, applied);
}

/* The capture mode a campaign run asks for when its request names none: campaigns are read prompt by prompt, so they capture full
   content. The server's ceiling still applies (`capCaptureMode`); an ordinary run keeps the default. */
export const CAMPAIGN_CAPTURE_MODE: CaptureMode = "full";

export function requestedCaptureMode(req: { readonly captureMode?: CaptureMode; readonly campaign?: unknown }): CaptureMode | undefined {
  return req.captureMode ?? (req.campaign ? CAMPAIGN_CAPTURE_MODE : undefined);
}
