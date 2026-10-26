/*
 * REST control API for the interactive layer (bin/qa) and any future operator
 * surface. It NEVER does git writes directly: it only enqueues runs on the same
 * sequential queue the webhook uses, and reads the in-memory run history. Every
 * dependency (config, ref resolution, history, queue) is injected via ApiDeps, so
 * the routing + validation logic is unit-tested with stubs — no fs or network.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, respondError } from "./api/api-error";
import type { ApiDeps } from "./api/deps";
import { normalizeApiPath, matchRoute } from "./api/route-table";
import { sendResult } from "./api/respond";
import { redactionPort } from "./api/support";
import { logJson } from "../integrations/logger";

/*
 * Answers the request from the route table. Returns true when the request matched an /api route (so the
 * caller stops here), false when no route has its path.
 */
export async function routeApi(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = matchRoute(req.method ?? "", normalizeApiPath(url.pathname));
  if (match.kind === "none") return false;
  if (match.kind === "method-not-allowed") {
    respondError(res, new ApiError(405, "method not allowed", { headers: { Allow: match.allow.join(", ") } }));
    return true;
  }
  try {
    const params = match.route.params ? match.route.params.safeParse(match.params) : undefined;
    if (params && !params.success) throw new ApiError(400, params.error.issues.map((i) => i.message).join("; "));
    sendResult(res, await match.route.handler({ req, res, deps, url, params: params?.data ?? match.params }));
  } catch (err) {
    if (err instanceof ApiError) {
      respondError(res, err);
      return true;
    }
    /* A fault no route named: the operator reads the redacted message in the log; the caller learns only that it failed (a fault's text can carry paths, stacks or queries). */
    logJson("error", "api request failed", { method: req.method, path: url.pathname, error: redactionPort.redactError(err) });
    if (res.headersSent) res.end();
    else respondError(res, new ApiError(500, "internal error"));
  }
  return true;
}
