/* Every route of the control API: its method, path, who may call it and the handler. One compiled matcher serves them all. */

import { z } from "zod";
import type { ApiContext } from "./context";
import type { ApiResult } from "./respond";
import { agentModels, getAgentConfig, putAgentConfig, restartAgent } from "./handlers/agent";
import {
  boundaryStatusRoute,
  confirmBoundariesRoute,
  createApp,
  deleteApp,
  getApp,
  listApps,
  listRepos,
  loginBootstrap,
  proposeBoundariesRoute,
  updateApp,
} from "./handlers/apps";
import { localLogin, login } from "./handlers/auth";
import { campaignRuns, CampaignIdParamSchema, evaluationCatalog, regradeJob, runEvaluation, startRegrade } from "./handlers/evaluations";
import { help } from "./handlers/help";
import { appContextMap, appIntelligence, appReport, appTelemetry, appTrends, coordinationEvents, runReport, signals } from "./handlers/insights";
import { askRun, cancelRun, continueRunRoute, getRun, listRuns, postRun, runTurns, streamRunEvents } from "./handlers/runs";
import { health, queue, telemetryHealth, version } from "./handlers/system";

export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ApiRoute {
  readonly method: RouteMethod;
  /* The path under `/api`, with `:name` segments for parameters: "/runs/:id/events". */
  readonly path: string;
  /* `public` answers without credentials; `bearer` needs the machine token or a user session. */
  readonly auth: "bearer" | "public";
  /* Checks and reshapes the path parameters before the handler runs; a failure answers 400. */
  readonly params?: z.ZodType<Record<string, string>>;
  readonly handler: (ctx: ApiContext) => ApiResult | Promise<ApiResult>;
}

const bearer = (method: RouteMethod, path: string, handler: ApiRoute["handler"], params?: ApiRoute["params"]): ApiRoute => ({ method, path, auth: "bearer", handler, ...(params ? { params } : {}) });
const open = (method: RouteMethod, path: string, handler: ApiRoute["handler"]): ApiRoute => ({ method, path, auth: "public", handler });

export const routes: readonly ApiRoute[] = [
  open("GET", "/health", health),
  open("GET", "/version", version),
  open("POST", "/auth/login", login),
  open("GET", "/auth/local", localLogin),

  bearer("POST", "/runs", postRun),
  bearer("GET", "/runs", listRuns),
  bearer("GET", "/runs/:id", getRun),
  bearer("DELETE", "/runs/:id", cancelRun),
  bearer("GET", "/runs/:id/events", streamRunEvents),
  bearer("GET", "/runs/:id/turns", runTurns),
  bearer("GET", "/runs/:id/report", runReport),
  bearer("GET", "/runs/:id/evaluation", runEvaluation),
  bearer("POST", "/runs/:id/ask", askRun),
  bearer("POST", "/runs/:id/continue", continueRunRoute),

  bearer("GET", "/evaluations/catalog", evaluationCatalog),
  bearer("POST", "/evaluations/regrade", startRegrade),
  bearer("GET", "/evaluations/regrade/:jobId", regradeJob),
  bearer("GET", "/campaigns/:campaignId/runs", campaignRuns, z.object({ campaignId: CampaignIdParamSchema })),

  bearer("GET", "/apps", listApps),
  bearer("POST", "/apps", createApp),
  bearer("GET", "/apps/:name", getApp),
  bearer("PUT", "/apps/:name", updateApp),
  bearer("DELETE", "/apps/:name", deleteApp),
  bearer("POST", "/apps/:name/boundaries/propose", proposeBoundariesRoute),
  bearer("GET", "/apps/:name/boundaries/propose/status", boundaryStatusRoute),
  bearer("POST", "/apps/:name/boundaries/confirm", confirmBoundariesRoute),
  bearer("POST", "/apps/:name/login-bootstrap", loginBootstrap),
  bearer("GET", "/apps/:name/intelligence", appIntelligence),
  bearer("GET", "/apps/:name/context-map", appContextMap),
  bearer("GET", "/apps/:name/trends", appTrends),
  bearer("GET", "/apps/:name/telemetry", appTelemetry),
  bearer("GET", "/apps/:name/report", appReport),

  bearer("GET", "/repos", listRepos),
  bearer("GET", "/queue", queue),
  bearer("GET", "/signals", signals),
  bearer("GET", "/coordination-events", coordinationEvents),
  bearer("GET", "/telemetry/health", telemetryHealth),

  bearer("GET", "/agent/config", getAgentConfig),
  bearer("PUT", "/agent/config", putAgentConfig),
  bearer("GET", "/agent/models", agentModels),
  bearer("POST", "/agent/restart", restartAgent),

  bearer("POST", "/help", help),
];

/* The request path with the version prefix folded away: `/api/v1/runs` and `/api/runs` are one route. */
export function normalizeApiPath(pathname: string): string {
  return pathname.replace(/^\/api\/v1(?=\/|$)/, "/api");
}

interface CompiledRoute {
  readonly route: ApiRoute;
  readonly segments: readonly string[];
}

function compile(route: ApiRoute): CompiledRoute {
  return { route, segments: `/api${route.path}`.split("/") };
}

function matchSegments(pattern: readonly string[], actual: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i]!;
    const got = actual[i]!;
    if (expected.startsWith(":")) {
      if (got === "") return undefined;
      params[expected.slice(1)] = got;
    } else if (expected !== got) {
      return undefined;
    }
  }
  return params;
}

export type RouteMatch =
  | { readonly kind: "matched"; readonly route: ApiRoute; readonly params: Record<string, string> }
  | { readonly kind: "method-not-allowed"; readonly allow: readonly RouteMethod[] }
  | { readonly kind: "none" };

export function createMatcher(table: readonly ApiRoute[]): (method: string, apiPath: string) => RouteMatch {
  const compiled = table.map(compile);
  return (method, apiPath) => {
    const actual = apiPath.split("/");
    const allow: RouteMethod[] = [];
    for (const { route, segments } of compiled) {
      const params = matchSegments(segments, actual);
      if (!params) continue;
      if (route.method === method) return { kind: "matched", route, params };
      allow.push(route.method);
    }
    return allow.length > 0 ? { kind: "method-not-allowed", allow } : { kind: "none" };
  };
}

export const matchRoute = createMatcher(routes);

/* True when the request needs no credentials: it matches a route declared `public`. */
export function isPublicRoute(method: string, apiPath: string): boolean {
  const match = matchRoute(method, apiPath);
  return match.kind === "matched" && match.route.auth === "public";
}
