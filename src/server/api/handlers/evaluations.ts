/* Routes about evaluation: a run's scores, the grader catalog, regrade jobs and a campaign's runs. */

import { CAMPAIGN_ID_PATTERN } from "../../../contract/campaign";
import {
  CampaignRunsSchema,
  EvaluationCatalogSchema,
  RegradeJobSchema,
  RegradeRequestSchema,
  RegradeStartedSchema,
  RunEvaluationSchema,
} from "../../../contract/commands";
import { RegradeRequestError } from "@contexts/evaluation/application/index";
import { z } from "zod";
import { ApiError } from "../api-error";
import { param, type ApiContext } from "../context";
import { parseJsonBody } from "../request";
import { reply, type ApiResult } from "../respond";
import { redactionPort } from "../support";
import type { ApiDeps } from "../deps";
import type { EvaluationService } from "../../evaluation-service";

function evaluationOf(deps: ApiDeps): EvaluationService {
  if (!deps.evaluation) throw new ApiError(501, "evaluation is not configured");
  return deps.evaluation;
}

/* The campaign id as a client sent it: percent-decoded, and a valid identifier. */
export const CampaignIdParamSchema = z.string().transform((raw, ctx) => {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    ctx.addIssue({ code: "custom", message: "the campaign id is not valid URL encoding" });
    return z.NEVER;
  }
  if (!CAMPAIGN_ID_PATTERN.test(id)) {
    ctx.addIssue({ code: "custom", message: "the campaign id must be 1-100 characters of A-Z a-z 0-9 _ . : -" });
    return z.NEVER;
  }
  return id;
});

export function runEvaluation(ctx: ApiContext): ApiResult {
  const id = param(ctx, "id");
  const versions = ctx.url.searchParams.get("versions");
  const evaluation = evaluationOf(ctx.deps);
  if (versions !== null && versions !== "all") throw new ApiError(400, "'versions' must be \"all\" or absent");
  const view = evaluation.evaluation(id, versions === "all");
  if (!view) throw new ApiError(404, `run not found: ${id}`);
  return reply.contract(200, RunEvaluationSchema, { schemaVersion: 1, ...view });
}

export function evaluationCatalog(ctx: ApiContext): ApiResult {
  return reply.contract(200, EvaluationCatalogSchema, { schemaVersion: 1, ...evaluationOf(ctx.deps).catalog() });
}

export async function startRegrade(ctx: ApiContext): Promise<ApiResult> {
  const evaluation = evaluationOf(ctx.deps);
  const { runIds, campaignId, since, graders } = await parseJsonBody(ctx.req, RegradeRequestSchema);
  const g = graders ? { graders } : {};
  try {
    const started = evaluation.startRegrade(runIds ? { runIds, ...g } : campaignId ? { campaignId, ...g } : { since: since!, ...g });
    return reply.contract(202, RegradeStartedSchema, { schemaVersion: 1, ...started });
  } catch (err) {
    if (err instanceof RegradeRequestError) throw new ApiError(400, err.message);
    throw new ApiError(500, `failed to start the regrade: ${redactionPort.redactError(err)}`);
  }
}

export function regradeJob(ctx: ApiContext): ApiResult {
  const jobId = param(ctx, "jobId");
  const job = evaluationOf(ctx.deps).regradeJob(jobId);
  if (!job) throw new ApiError(404, `regrade job not found: ${jobId}`);
  return reply.contract(200, RegradeJobSchema, { schemaVersion: 1, ...job });
}

/* GET /campaigns/:id/runs?variant.<k>=<v>: the campaign's runs, narrowed to those carrying every label named in the query. */
export function campaignRuns(ctx: ApiContext): ApiResult {
  const campaignId = param(ctx, "campaignId");
  const evaluation = evaluationOf(ctx.deps);
  const filter: Record<string, string> = {};
  for (const [name, value] of ctx.url.searchParams) {
    if (!name.startsWith("variant.")) throw new ApiError(400, `unknown query parameter '${name}': only 'variant.<key>=<value>' filters are accepted`);
    const key = name.slice("variant.".length);
    if (key === "" || Object.hasOwn(filter, key)) {
      throw new ApiError(400, key === "" ? "a variant filter needs a key: variant.<key>=<value>" : `variant filter '${key}' is given more than once`);
    }
    filter[key] = value;
  }
  return reply.contract(200, CampaignRunsSchema, { schemaVersion: 1, ...evaluation.campaignRuns(campaignId, filter) });
}
