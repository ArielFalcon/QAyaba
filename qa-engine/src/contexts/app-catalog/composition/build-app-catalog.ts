/* Builds the app-catalog context: the auth session an e2e run signs in through. The session holds the run's login material, so it is built here from the adapter's own deps and nowhere else. */

import type { AuthSessionPort } from "../application/index.ts";
import { AuthSessionAdapter, type AuthSessionAdapterDeps } from "../infrastructure/auth-session.adapter.ts";

export interface AppCatalogDeps {
  /* Absent for a code target or an app with no DEV url: no session is served, never a stub. */
  authSession?: AuthSessionAdapterDeps;
}

export interface AppCatalogApi {
  authSession?: AuthSessionPort;
}

export function buildAppCatalog(deps: AppCatalogDeps): AppCatalogApi {
  return deps.authSession ? { authSession: new AuthSessionAdapter(deps.authSession) } : {};
}
