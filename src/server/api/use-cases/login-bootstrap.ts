/* POST /apps/:name/login-bootstrap: the run that establishes and proves an app's login. */

import { LoginBootstrapResultSchema } from "../../../contract/commands";
import { ApiError } from "../api-error";
import type { ApiDeps } from "../deps";
import { reply, type ApiResult } from "../respond";
import { loadApp, redactionPort } from "../support";

/*
 * Only a form login is authored (a client certificate needs no login script, a public app no login, a code app no browser),
 * so anything else is a 409 rather than a run that could only fail.
 */
export async function startLoginBootstrap(deps: ApiDeps, name: string): Promise<ApiResult> {
  const bootstrapLogin = deps.bootstrapLogin;
  if (!bootstrapLogin) throw new ApiError(501, "login bootstrap is not available", { bare: true });
  const appConfig = loadApp(deps, name);
  if (appConfig.code === true || appConfig.auth?.kind !== "form") {
    throw new ApiError(409, `app '${name}' declares no form login to bootstrap`, { bare: true });
  }
  let sha: string;
  try {
    sha = await deps.resolveRef(appConfig.repo, appConfig.baseBranch ?? "main");
  } catch (err) {
    throw new ApiError(400, redactionPort.redactError(err), { bare: true });
  }
  let id: string;
  try {
    id = bootstrapLogin(appConfig.name, sha);
  } catch (err) {
    throw new ApiError(500, `failed to enqueue the login run: ${err instanceof Error ? err.message : String(err)}`, { bare: true });
  }
  if (!id) throw new ApiError(503, "service shutting down", { bare: true });
  return reply.contract(202, LoginBootstrapResultSchema, { id, app: appConfig.name, sha, status: "enqueued" });
}
