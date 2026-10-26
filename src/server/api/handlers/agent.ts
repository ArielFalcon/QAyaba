/* Routes about the agent runtime: its configuration, the models a provider offers and restarting a provider. */

import {
  AgentConfigApplyResultSchema,
  AgentConfigUpdateSchema,
  AgentModelsResponseSchema,
  AgentProviderSchema,
  AgentRestartRequestSchema,
  AgentRestartResponseSchema,
  PublicAgentConfigSchema,
} from "../../../contract/commands";
import { ApiError } from "../api-error";
import type { ApiContext } from "../context";
import type { ApiDeps } from "../deps";
import { parseJsonBody, withIssues } from "../request";
import { reply, type ApiResult } from "../respond";
import { redactionPort } from "../support";

const UNAVAILABLE = "agent runtime configuration is not available";

function runtimeOf(deps: ApiDeps): NonNullable<ApiDeps["agentRuntime"]> {
  if (!deps.agentRuntime) throw new ApiError(501, UNAVAILABLE, { bare: true });
  return deps.agentRuntime;
}

function isAgentRuntimeBusy(deps: ApiDeps): boolean {
  const run = deps.currentRun();
  return run?.status === "running" || run?.status === "enqueued" || deps.agentRuntime?.hasOpenSessions?.() === true;
}

function runtimeStatusFromErrorMessage(message: string): number {
  if (message.includes("active") || message.includes("session")) return 409;
  if (message.includes("model") || message.includes("API_KEY") || message.includes("required") || message.includes("invalid")) return 422;
  return 502;
}

export async function getAgentConfig(ctx: ApiContext): Promise<ApiResult> {
  const runtime = runtimeOf(ctx.deps);
  try {
    return reply.contract(200, PublicAgentConfigSchema, await runtime.getConfig());
  } catch (err) {
    throw new ApiError(502, `agent runtime failed: ${redactionPort.redactError(err)}`, { bare: true });
  }
}

export async function putAgentConfig(ctx: ApiContext): Promise<ApiResult> {
  const runtime = runtimeOf(ctx.deps);
  if (isAgentRuntimeBusy(ctx.deps)) throw new ApiError(409, "agent runtime cannot be changed while a run or agent session is active", { bare: true });
  const input = await parseJsonBody(ctx.req, AgentConfigUpdateSchema, { bare: true, invalid: withIssues("invalid agent runtime config") });
  try {
    return reply.contract(200, AgentConfigApplyResultSchema, await runtime.applyConfig(input));
  } catch (err) {
    const message = redactionPort.redactError(err);
    throw new ApiError(runtimeStatusFromErrorMessage(message), message, { bare: true });
  }
}

export async function agentModels(ctx: ApiContext): Promise<ApiResult> {
  const runtime = runtimeOf(ctx.deps);
  const provider = AgentProviderSchema.safeParse(ctx.url.searchParams.get("provider"));
  if (!provider.success) throw new ApiError(400, "?provider=opencode is required", { bare: true });
  try {
    const models = await runtime.listModels(provider.data);
    return reply.contract(200, AgentModelsResponseSchema, { provider: provider.data, models });
  } catch (err) {
    throw new ApiError(502, `failed to list agent models: ${redactionPort.redactError(err)}`, { bare: true });
  }
}

export async function restartAgent(ctx: ApiContext): Promise<ApiResult> {
  const runtime = runtimeOf(ctx.deps);
  if (isAgentRuntimeBusy(ctx.deps)) throw new ApiError(409, "agent runtime cannot be restarted while a run or agent session is active", { bare: true });
  const { provider } = await parseJsonBody(ctx.req, AgentRestartRequestSchema, { bare: true, invalid: withIssues("invalid restart request") });
  try {
    return reply.contract(200, AgentRestartResponseSchema, { health: await runtime.restart(provider) });
  } catch (err) {
    throw new ApiError(502, `failed to restart agent provider: ${redactionPort.redactError(err)}`, { bare: true });
  }
}
