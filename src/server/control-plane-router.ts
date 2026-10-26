/* The control plane's request sequence, in order: CORS preflight, the `/api` surface (version prefix normalization, the Bearer auth gate, the per-address throttle on the public sign-in routes, metrics, the maintainer routes, the API), the same-origin web console, and the deployment webhook for any other POST. Everything it touches is injected, so the whole sequence runs over fakes. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isPublicRoute, normalizeApiPath } from "./api/route-table";
import type { RateLimiter } from "./rate-limit";

export interface ControlPlaneDeps {
  /* True when the request carries the machine token or a valid user session. */
  authorize(req: IncomingMessage): boolean;
  /* Throttles the unauthenticated sign-in routes per client address. */
  loginLimiter: RateLimiter;
  /* The Prometheus text of `GET /api/metrics`. */
  metrics(): string;
  /* Handles `/api/maintainer*`; false when no route matched. */
  maintainer(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /* Handles the rest of `/api`; false when no route matched. */
  api(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /* Serves the web console under `/app`; false when it answered nothing. */
  dashboard(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /* Handles a POST outside `/api`: the deployment webhook. */
  webhook(req: IncomingMessage, res: ServerResponse): void;
  /* Whether an answered API request is worth an access log line. */
  shouldLogApiRequest(method: string | undefined, status: number): boolean;
  log(level: "info", message: string, meta?: Record<string, unknown>): void;
  now(): number;
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}

export function createControlPlaneHandler(deps: ControlPlaneDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const traceId = req.headers["x-trace-id"] as string | undefined;
    const startTime = deps.now();

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path.startsWith("/api")) {
      /*
       * The liveness probe (session count only) and the version/capability handshake
       * are unauthenticated: the internal poller and external checks need the former,
       * and the connect screen needs the latter BEFORE auth so a stale binary can be
       * told to update even with a wrong token. Neither exposes secrets.
       */
      const apiPath = normalizeApiPath(path);
      /*
       * Public (pre-auth) surface: liveness, the version handshake, GitHub login, and the
       * same-origin local-console bootstrap. None of these return the API token. /auth/local
       * is public at the gate; the handler 404s untrusted callers (see localWebLoginAllowed).
       */
      const isPublic = isPublicRoute(req.method ?? "GET", apiPath);
      if (!isPublic && !deps.authorize(req)) {
        json(res, 401, { schemaVersion: 1, error: "unauthorized" });
        return;
      }
      /*
       * Throttle the public auth bootstrap per client IP. Login fans out to GitHub; local
       * minting is cheap but still unauthenticated, so it shares the same window.
       */
      const isAuthBootstrap = apiPath === "/api/auth/login" || apiPath === "/api/auth/local";
      if (isAuthBootstrap && !deps.loginLimiter.allow(req.socket.remoteAddress ?? "")) {
        json(res, 429, { error: "too many login attempts — try again in a minute" }, { "Retry-After": "60" });
        return;
      }
      if (path === "/api/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(deps.metrics());
        return;
      }
      if (path.startsWith("/api/maintainer")) {
        if (await deps.maintainer(req, res)) return;
        json(res, 404, { error: "not found" });
        return;
      }
      if (await deps.api(req, res)) {
        if (deps.shouldLogApiRequest(req.method, res.statusCode)) deps.log("info", `API request`, { traceId, path, duration: deps.now() - startTime });
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }

    /*
     * The web console (web/public, served as-is) is served same-origin at /app, so it shares the
     * orchestrator's origin and the operator's credentials (no CORS). A missing web/public answers a
     * placeholder page. The /api surface above stays Bearer-protected.
     */
    if (req.method === "GET" && (path === "/app" || path.startsWith("/app/"))) {
      if (await deps.dashboard(req, res)) return;
    }

    if (req.method === "POST") {
      deps.webhook(req, res);
      return;
    }

    json(res, 404, { error: "not found" });
  };
}
