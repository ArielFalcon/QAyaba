/* Whether a suite child receives the test account. Only an app that opted in (e2e.specCredentials: account) hands its specs one; every other child gets none, and the `login` profile alone carries the account otherwise. Pure: the shell hands in the environment. */

/* The part of an app's config this rule reads. */
export interface SuiteAccountDeclaration {
  e2e?: { specCredentials?: "none" | "account" | undefined } | undefined;
  auth?: { usernameEnv?: string | undefined; passwordEnv?: string | undefined } | undefined;
}

/* The account an opted-in app's specs may log in with: the one its auth declaration names, else the conventional DEV_TEST_USER / DEV_TEST_PASS. None when the app did not opt in, or the environment holds no such account. */
export function suiteAccountFor(app: SuiteAccountDeclaration, env: Readonly<Record<string, string | undefined>>): { user: string; pass: string } | undefined {
  if (app.e2e?.specCredentials !== "account") return undefined;
  const user = env[app.auth?.usernameEnv ?? "DEV_TEST_USER"];
  const pass = env[app.auth?.passwordEnv ?? "DEV_TEST_PASS"];
  return user && pass ? { user, pass } : undefined;
}
