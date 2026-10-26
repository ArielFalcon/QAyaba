/* The HTTP side of the deployment webhook (POST on any non-API path): fail closed without a secret, bound the body, check the signature through handleWebhook, then enqueue one run per app the event dispatches to. The body shape `{ message }` is what GitHub-facing callers read, so it differs from the API's error shape on purpose. */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppRepositoryPort } from "@contexts/app-catalog/application/index.ts";
import type { ApiDeps } from "./api/deps";
import { guardResponse } from "./guarded-handler";
import { handleWebhook } from "./webhook";
import { resolveWebhookDispatch, type WebhookDispatch } from "./webhook-routing";

/* The most bytes of a webhook body the handler reads. */
export const MAX_WEBHOOK_BODY = 1_000_000;

export interface WebhookHandlerDeps {
  /* The shared secret that signs deliveries; absent, deliveries are refused unless `allowUnsigned`. */
  secret: string | undefined;
  allowUnsigned: boolean;
  maxBody?: number;
  catalog: AppRepositoryPort;
  /* The single enqueue funnel, shared with the API. */
  enqueue: ApiDeps["enqueue"];
  shuttingDown(): boolean;
  log(level: "warn" | "error", message: string, meta?: Record<string, unknown>): void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createWebhookHandler(deps: WebhookHandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBody = deps.maxBody ?? MAX_WEBHOOK_BODY;

  return (req, res) => {
    /* Fail closed: no webhook secret configured and not explicitly opted in → reject. */
    if (!deps.secret && !deps.allowUnsigned) {
      json(res, 401, { message: "webhook secret not configured (set WEBHOOK_SECRET or WEBHOOK_ALLOW_UNSIGNED=true)" });
      return;
    }
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBody) {
        aborted = true;
        json(res, 413, { message: "payload too large" });
        req.destroy();
      }
    });
    req.on("end", () => void guardResponse(res, async () => {
      if (aborted) return;
      const sig = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
      const result = handleWebhook(body, sig, { secret: deps.secret });
      if (result.payload) {
        if (deps.shuttingDown()) {
          json(res, 503, { message: "shutting down" });
          return;
        }
        const { repo, sha, mode, guidance, baseSha } = result.payload;

        let dispatch: WebhookDispatch[];
        try {
          dispatch = await resolveWebhookDispatch(deps.catalog, repo, { mode, guidance, baseSha });
        } catch (err) {
          deps.log("error", "webhook dispatch resolution failed", { error: err instanceof Error ? err.message : String(err), repo, sha });
          json(res, 500, { message: "internal error — could not resolve webhook dispatch" });
          return;
        }
        if (dispatch.length === 0) deps.log("warn", "no config/apps entry for repo; event ignored", { repo });
        for (const d of dispatch) {
          try {
            deps.enqueue({ ...d, sha });
          } catch (err) {
            deps.log("error", "webhook enqueue failed", { error: err instanceof Error ? err.message : String(err), repo, sha });
            json(res, 500, { message: "internal error — run could not be enqueued" });
            return;
          }
        }
      }
      json(res, result.status, { message: result.message });
    }, (message) => deps.log("error", message)));
  };
}
