/*
 * One browser session for an e2e run. Form login and a software certificate
 * both come back as files in the orchestrator-only auth directory (outside the
 * watched-repo mirror, so the agent never sees them); callers do not branch on
 * kind. A throw is infra-error. unauthored means the stock seed could not log
 * in and generation may rewrite e2e/auth.setup.ts.
 */

export interface AuthDeclaration {
  kind: "form" | "mtls";
  usernameEnv?: string;
  passwordEnv?: string;
  certEnv?: string;
  certPassEnv?: string;
  /** A path on the app's own origin where its login form lives; tried before the ladder's own guesses. Form logins only. */
  loginPath?: string;
}

export interface AuthSessionRequest {
  specDir: string;
  baseUrl: string;
  /** Absent means the app is public. */
  auth?: AuthDeclaration;
  /** pre-generate fail-opens a stock seed. pre-execute treats an authored setup failure as fatal. */
  phase: "pre-generate" | "pre-execute";
}

/** How a login was settled and how long it took, for measurement. Only discovery reports it so far. */
export interface AuthResolution {
  method: "discovery" | "seed" | "authored" | "mtls";
  ms: number;
}

export interface AuthSession {
  storageStatePath?: string;
  clientCertPath?: string;
  unauthored: boolean;
  resolution?: AuthResolution;
}

export interface AuthSessionContext {
  baseUrl: string;
  auth?: AuthDeclaration;
}

export interface AuthSessionPort {
  prepare(req: AuthSessionRequest, signal?: AbortSignal): Promise<AuthSession>;
}
