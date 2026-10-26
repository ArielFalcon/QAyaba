/* Routes that hand out a session: the GitHub token exchange and the same-origin console bootstrap. */

import { LoginRequestSchema, LoginResponseSchema } from "../../../contract/commands";
import { ApiError } from "../api-error";
import type { ApiContext } from "../context";
import { parseJsonBody } from "../request";
import { reply, type ApiResult } from "../respond";
import { redactionPort } from "../support";

/*
 * Exchange a GitHub user token (obtained by the client via the OAuth device flow) for a
 * short-lived server session. The deps.login closure does the GitHub verification + repo
 * authorization + session minting; this route is pure validation + status mapping:
 * 400 malformed, 401 bad/unknown GitHub token, 403 authenticated-but-not-a-collaborator.
 */
export async function login(ctx: ApiContext): Promise<ApiResult> {
  const exchange = ctx.deps.login;
  if (!exchange) throw new ApiError(501, "GitHub login is not configured on this server");

  const { githubToken } = await parseJsonBody(ctx.req, LoginRequestSchema, {
    invalid: () => new ApiError(400, "'githubToken' is required"),
  });

  try {
    const outcome = await exchange(githubToken);
    if (outcome.ok) return reply.contract(200, LoginResponseSchema, { token: outcome.token, username: outcome.username, expiresAt: outcome.expiresAt });
    if (outcome.reason === "forbidden") throw new ApiError(403, "this GitHub account cannot push to any watched repo");
    throw new ApiError(401, "the GitHub token was rejected");
  } catch (err) {
    if (err instanceof ApiError) throw err;
    /*
     * A GitHub API outage is infra, not a credential problem — surface it loudly, don't
     * masquerade it as a 401 (which would send the operator chasing a non-existent token bug).
     */
    throw new ApiError(502, `GitHub login failed: ${redactionPort.redactError(err)}`);
  }
}

export function localLogin(ctx: ApiContext): ApiResult {
  const unavailable = new ApiError(404, "local console login is not available");
  if (!ctx.deps.localLogin) throw unavailable;
  const outcome = ctx.deps.localLogin(ctx.req.socket?.remoteAddress ?? "", ctx.req.headers.host);
  if (!outcome) throw unavailable;
  return reply.contract(200, LoginResponseSchema, outcome);
}
