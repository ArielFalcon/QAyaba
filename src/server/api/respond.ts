/* What a route hands back, and the one place it becomes a response. */

import type { ServerResponse } from "node:http";
import type { z } from "zod";
import { json } from "../helpers";
import { ApiError, respondError } from "./api-error";

export type ApiResult =
  /* A body checked against its contract schema before it leaves. */
  | { readonly kind: "contract"; readonly status: number; readonly schema: z.ZodTypeAny; readonly body: unknown }
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | { readonly kind: "text"; readonly status: number; readonly contentType: string; readonly body: string }
  /* The route already wrote and owns the response (an event stream). */
  | { readonly kind: "streamed" };

export const reply = {
  contract: (status: number, schema: z.ZodTypeAny, body: unknown): ApiResult => ({ kind: "contract", status, schema, body }),
  json: (status: number, body: unknown): ApiResult => ({ kind: "json", status, body }),
  text: (status: number, contentType: string, body: string): ApiResult => ({ kind: "text", status, contentType, body }),
  streamed: { kind: "streamed" } as ApiResult,
};

export function sendResult(res: ServerResponse, result: ApiResult): void {
  switch (result.kind) {
    case "streamed":
      return;
    case "json":
      json(res, result.status, result.body);
      return;
    case "text":
      res.writeHead(result.status, { "Content-Type": result.contentType });
      res.end(result.body);
      return;
    case "contract": {
      const checked = result.schema.safeParse(result.body);
      if (!checked.success) {
        /* Surface the drift loudly (AGENTS.md invariant): a silent 500 hides a real schema mismatch between the route and the contract. */
        console.error("[contract] response validation failed:", checked.error.issues);
        respondError(res, new ApiError(500, "contract response validation failed", { bare: true }));
        return;
      }
      json(res, result.status, checked.data);
    }
  }
}
