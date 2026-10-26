/* The failure a route throws: a status, a message and, for a few bodies, fields that travel beside the message. `respondError` is the only writer of an error response. */

import type { ServerResponse } from "node:http";
import { json } from "../helpers";

export interface ApiErrorOptions {
  /* Fields that join the message in the body (a schema's issues, for example). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /* Headers that join the response (`Allow` on a 405). */
  readonly headers?: Readonly<Record<string, string>>;
  /* The body carries no `schemaVersion`. */
  readonly bare?: true;
}

export class ApiError extends Error {
  readonly status: number;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly bare: boolean;

  constructor(status: number, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.extra = options.extra ?? {};
    this.headers = options.headers ?? {};
    this.bare = options.bare === true;
  }
}

export function respondError(res: ServerResponse, err: ApiError): void {
  const body = { ...(err.bare ? {} : { schemaVersion: 1 }), error: err.message, ...err.extra };
  if (Object.keys(err.headers).length === 0) {
    json(res, err.status, body);
    return;
  }
  res.writeHead(err.status, { "Content-Type": "application/json", ...err.headers });
  res.end(JSON.stringify(body));
}
