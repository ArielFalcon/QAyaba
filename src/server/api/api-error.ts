/* The failure a route throws: a status, a message and, for a few bodies, fields that travel beside the message. `respondError` is the only writer of an error response. */

import type { ServerResponse } from "node:http";
import { json } from "../helpers";

export interface ApiErrorOptions {
  /* Fields that join the message in the body (`issues` of a rejected request, `errors` of an invalid app config). */
  readonly extra?: Readonly<{ issues?: readonly unknown[]; errors?: readonly string[] }>;
  /* Headers that join the response (`Allow` on a 405, `Retry-After` on a 429). */
  readonly headers?: Readonly<Record<string, string>>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly extra: NonNullable<ApiErrorOptions["extra"]>;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.extra = options.extra ?? {};
    this.headers = options.headers ?? {};
  }
}

/* Every error answer of the API is `{ schemaVersion: 1, error }` plus the fields the failure carries. */
export function respondError(res: ServerResponse, err: ApiError): void {
  const body = { schemaVersion: 1, error: err.message, ...err.extra };
  if (Object.keys(err.headers).length === 0) {
    json(res, err.status, body);
    return;
  }
  res.writeHead(err.status, { "Content-Type": "application/json", ...err.headers });
  res.end(JSON.stringify(body));
}
