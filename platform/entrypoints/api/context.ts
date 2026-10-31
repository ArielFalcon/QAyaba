/* What a route handler receives: the request, the response it must not write itself, the injected dependencies and the path parameters. */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps } from "./deps";

export interface ApiContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly deps: ApiDeps;
  readonly url: URL;
  /* The path parameters, as they appear in the request path (percent-encoding intact). */
  readonly params: Readonly<Record<string, string>>;
}

/* A path parameter the route's pattern declares; asking for another name is a bug in the route. */
export function param(ctx: ApiContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) throw new Error(`route has no path parameter '${name}'`);
  return value;
}
