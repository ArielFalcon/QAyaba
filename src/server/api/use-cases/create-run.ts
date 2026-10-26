/* POST /runs: validates the request, resolves the commit to test and enqueues the run. */

import { CampaignInputSchema, CaptureModeSchema, CreateRunResultSchema, GroundingInputSchema, type GroundingInput } from "../../../contract/commands";
import type { CampaignIdentity } from "../../../contract/campaign";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import { RUN_MODES, type RunMode, type TestTarget } from "../../../types";
import { CampaignCaptureMismatchError } from "../../campaign-capture";
import { ApiError } from "../api-error";
import type { ApiDeps, RunObservabilityRequest } from "../deps";
import { reply, type ApiResult } from "../respond";
import { loadApp, redactionPort } from "../support";

const TARGETS: readonly TestTarget[] = ["e2e", "code"];

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/* The longest guidance a run request carries. */
export const MAX_GUIDANCE_LENGTH = 2000;

export async function createRun(deps: ApiDeps, body: Record<string, unknown>): Promise<ApiResult> {
  const appName = typeof body.app === "string" ? body.app : null;
  if (!appName) throw new ApiError(400, "'app' is required (config/apps/<app>.yaml name)");

  const appConfig = loadApp(deps, appName);

  const target: TestTarget =
    typeof body.target === "string" && (TARGETS as readonly string[]).includes(body.target)
      ? (body.target as TestTarget)
      : appConfig.code
        ? "code"  /* default to code mode for code-mode apps */
        : "e2e";
  const mode: RunMode =
    typeof body.mode === "string" && (RUN_MODES as readonly string[]).includes(body.mode) ? (body.mode as RunMode) : "diff";
  const guidance = typeof body.guidance === "string" ? body.guidance.slice(0, MAX_GUIDANCE_LENGTH) : undefined;
  const shadow = typeof body.shadow === "boolean" ? body.shadow : undefined;
  const commits =
    typeof body.commits === "number" && Number.isInteger(body.commits) && body.commits >= 1 && body.commits <= 20
      ? body.commits
      : undefined;

  let sha: string;
  if (typeof body.sha === "string" && SHA_PATTERN.test(body.sha)) {
    sha = body.sha;
  } else if (typeof body.sha === "string" && body.sha.length > 0) {
    throw new ApiError(400, "'sha' must be 7–40 hex characters");
  } else {
    /*
     * Neither a sha nor an explicit ref: default to the app's base branch HEAD. This
     * is the TUI "launch" path (pick target/mode/shadow, no commit) — run the latest
     * of the configured branch. resolveRef uses `git ls-remote`, so no mirror is
     * required yet (works on the very first run).
     */
    const ref = typeof body.ref === "string" && body.ref.length > 0 ? body.ref : (appConfig.baseBranch ?? "main");
    try {
      sha = await deps.resolveRef(appConfig.repo, ref);
    } catch (err) {
      throw new ApiError(400, redactionPort.redactError(err));
    }
  }

  /* Range start for a diff run (the diff spans baseSha..sha), validated like the sha: it reaches git as an argument. */
  let baseSha: string | undefined;
  if (typeof body.baseSha === "string" && body.baseSha.length > 0) {
    if (!SHA_PATTERN.test(body.baseSha)) throw new ApiError(400, "'baseSha' must be 7–40 hex characters");
    baseSha = body.baseSha;
  }

  if (body.closedLoop !== undefined && typeof body.closedLoop !== "boolean") throw new ApiError(400, "'closedLoop' must be a boolean");
  const closedLoop = typeof body.closedLoop === "boolean" ? body.closedLoop : undefined;

  if (body.agentBrowser !== undefined && typeof body.agentBrowser !== "boolean") throw new ApiError(400, "'agentBrowser' must be a boolean");
  const agentBrowser = typeof body.agentBrowser === "boolean" ? body.agentBrowser : undefined;

  let campaign: CampaignIdentity | undefined;
  if (body.campaign !== undefined) {
    const parsed = CampaignInputSchema.safeParse(body.campaign);
    if (!parsed.success) throw new ApiError(400, `'campaign' is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    campaign = parsed.data;
  }
  let captureMode: CaptureMode | undefined;
  if (body.captureMode !== undefined) {
    const parsed = CaptureModeSchema.safeParse(body.captureMode);
    if (!parsed.success) throw new ApiError(400, "'captureMode' must be \"off\", \"metadata\" or \"full\"");
    captureMode = parsed.data;
  }
  let grounding: GroundingInput | undefined;
  if (body.grounding !== undefined) {
    const parsed = GroundingInputSchema.safeParse(body.grounding);
    if (!parsed.success) throw new ApiError(400, `'grounding' is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    grounding = parsed.data;
  }
  const observability: RunObservabilityRequest = { ...(campaign ? { campaign } : {}), ...(captureMode ? { captureMode } : {}) };

  let id: string;
  try {
    id = deps.enqueue(appConfig.name, sha, target, mode, guidance, shadow, commits, undefined, baseSha, closedLoop, agentBrowser, observability, grounding);
  } catch (err) {
    if (err instanceof CampaignCaptureMismatchError) throw new ApiError(409, err.message);
    throw new ApiError(500, `failed to enqueue run: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!id) throw new ApiError(503, "service shutting down");
  return reply.contract(202, CreateRunResultSchema, { schemaVersion: 1, id, app: appConfig.name, sha, target, mode, status: "enqueued" });
}
