/* Operator-declared app login for e2e targets whose login lives on a central web (a different origin than the app) and returns by redirect. Non-secret: URLs and selectors only — credentials stay in DEV_TEST_USER / DEV_TEST_PASS.
 *
 * The orchestrator materializes it into the working copy as E2E_AUTH_FILE (never committed, never published) so every consumer reads the same declaration from the e2e directory: the seed `authenticate()` fixture, the DOM capture that grounds selectors on authenticated routes, the fault-injection pass (which must not corrupt the login's own traffic), and the agent. */

/* Relative to the e2e directory. */
export const E2E_AUTH_FILE = ".qa/auth.local.json";

export interface E2eAuthConfig {
  /* URL prefix of the central login page (e.g. "https://sso.example.com/"). Reaching it means the app asked for a login. */
  loginUrl: string;
  /* App path that starts the flow. Default "/". */
  startPath?: string;
  /* Selector clicked in the app to start the login, when opening startPath does not redirect by itself. */
  trigger?: string;
  /* Selector clicked on the login page to reach the username/password form (e.g. after a certificate step). Clicked only when visible. */
  passwordEntry?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  /* Element visible only once logged in. Makes success detection exact instead of URL-based. */
  successSelector?: string;
  /* How long to wait for the redirect to the login page before concluding the session is already valid. Default 10000. */
  redirectTimeoutMs?: number;
  /* Per-step timeout for the form and the return redirect. Default 30000. */
  timeoutMs?: number;
}
