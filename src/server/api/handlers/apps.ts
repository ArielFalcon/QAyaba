/* Routes about watched apps: list, read, onboard, update, delete, repo listing, login bootstrap and boundary profiles. */

import { z } from "zod";
import {
  AppViewSchema,
  ConfirmBoundariesInputSchema,
  CreateAppInputSchema,
  CreateAppResultSchema,
  DeleteAppResultSchema,
  ProposeBoundariesInputSchema,
  RepoListResponseSchema,
  UpdateAppInputSchema,
} from "../../../contract/commands";
import { AppConfigInvalidError, AppNotFoundError } from "../../../orchestrator/config-loader";
import type { CreateAppInput as AdminCreateAppInput, UpdateAppInput as AdminUpdateAppInput } from "../../app-admin";
import { ApiError } from "../api-error";
import { param, type ApiContext } from "../context";
import { parseJsonBody, withIssues } from "../request";
import { reply, type ApiResult } from "../respond";
import { appView, loadApp, redactionPort } from "../support";
import { boundaryStatus, confirmBoundaries, proposeBoundaries, requireBoundaries } from "../use-cases/boundaries";
import { startLoginBootstrap } from "../use-cases/login-bootstrap";

export function listApps(ctx: ApiContext): ApiResult {
  const apps: Array<{ name: string; repo: string; baseUrl: string; shadow: boolean }> = [];
  for (const app of ctx.deps.listApps()) {
    try {
      apps.push(appView(app));
    } catch {
      /* A single malformed config should not hide every other app. */
    }
  }
  return reply.contract(200, z.array(AppViewSchema), apps);
}

export function getApp(ctx: ApiContext): ApiResult {
  return reply.contract(200, AppViewSchema, appView(loadApp(ctx.deps, param(ctx, "name"))));
}

export async function createApp(ctx: ApiContext): Promise<ApiResult> {
  const { deps } = ctx;
  if (!deps.createApp) throw new ApiError(501, "app onboarding is not available", { bare: true });
  const input = await parseJsonBody(ctx.req, CreateAppInputSchema, { bare: true, invalid: withIssues("invalid app create input") });
  if (!input.repo.includes("/")) throw new ApiError(400, "'repo' is required in 'org/name' form", { bare: true });
  try {
    const result = await deps.createApp(input as AdminCreateAppInput);
    if (!result.ok) return reply.json(422, { errors: result.errors ?? ["invalid app config"] });
    /* env VALUES never travel back; CreateAppResult only carries the key names. */
    return reply.contract(input.dryRun || input.validateOnly ? 200 : 201, CreateAppResultSchema, result);
  } catch (err) {
    throw new ApiError(500, redactionPort.redactError(err), { bare: true });
  }
}

export async function updateApp(ctx: ApiContext): Promise<ApiResult> {
  const { deps } = ctx;
  const name = param(ctx, "name");
  if (!deps.updateApp) throw new ApiError(501, "app update is not available", { bare: true });
  const input = await parseJsonBody(ctx.req, UpdateAppInputSchema, { bare: true, invalid: withIssues("invalid app update input") });
  try {
    const result = await deps.updateApp({ ...input, name } as AdminUpdateAppInput);
    if (!result.ok) return reply.json(422, { errors: result.errors ?? ["invalid app config"] });
    return reply.contract(200, CreateAppResultSchema, result);
  } catch (err) {
    throw new ApiError(500, redactionPort.redactError(err), { bare: true });
  }
}

export function deleteApp(ctx: ApiContext): ApiResult {
  const { deps } = ctx;
  if (!deps.deleteApp) throw new ApiError(501, "app deletion is not available", { bare: true });
  try {
    return reply.contract(200, DeleteAppResultSchema, deps.deleteApp(param(ctx, "name"), ctx.url.searchParams.get("purge") === "1"));
  } catch (err) {
    throw new ApiError(err instanceof AppNotFoundError ? 404 : err instanceof AppConfigInvalidError ? 422 : 500, redactionPort.redactError(err), { bare: true });
  }
}

export async function listRepos(ctx: ApiContext): Promise<ApiResult> {
  const { deps } = ctx;
  const owner = ctx.url.searchParams.get("owner");
  const page = Number(ctx.url.searchParams.get("page")) || 1;
  if (!owner) throw new ApiError(400, "'owner' query parameter is required (e.g. /api/repos?owner=arielyumn)", { bare: true });
  if (!deps.listRepos) throw new ApiError(501, "repo listing is not available", { bare: true });
  try {
    return reply.contract(200, RepoListResponseSchema, await deps.listRepos(owner, page));
  } catch (err) {
    const msg = redactionPort.redactError(err);
    const status = msg.includes("not found") || msg.includes("no repos found") ? 404
      : msg.includes("token") || msg.includes("GITHUB_TOKEN") ? 401
      : 500;
    throw new ApiError(status, msg, { bare: true });
  }
}

export function loginBootstrap(ctx: ApiContext): Promise<ApiResult> {
  return startLoginBootstrap(ctx.deps, param(ctx, "name"));
}

export async function proposeBoundariesRoute(ctx: ApiContext): Promise<ApiResult> {
  requireBoundaries(ctx.deps);
  const input = await parseJsonBody(ctx.req, ProposeBoundariesInputSchema, { optional: true, bare: true, invalid: withIssues("invalid propose-boundaries input") });
  return proposeBoundaries(ctx.deps, param(ctx, "name"), input);
}

export function boundaryStatusRoute(ctx: ApiContext): ApiResult {
  return boundaryStatus(ctx.deps, param(ctx, "name"));
}

export async function confirmBoundariesRoute(ctx: ApiContext): Promise<ApiResult> {
  requireBoundaries(ctx.deps);
  await parseJsonBody(ctx.req, ConfirmBoundariesInputSchema, { bare: true, invalid: withIssues("invalid confirm-boundaries input") });
  return confirmBoundaries(ctx.deps, param(ctx, "name"));
}
