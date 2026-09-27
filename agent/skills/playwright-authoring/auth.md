# Authentication (two layers)

This app has **two distinct credentials**. Do not confuse them.

## Layer 1 — DEV environment gate (HTTP Basic Auth)

The whole DEV environment is protected by the browser's native dialog
(username/password). **You do not interact with that dialog**: it is handled by
`httpCredentials`, already configured in `playwright.config.ts` from
`DEV_ENV_USER`/`DEV_ENV_PASS` and scoped to the app origin. You do not need to do
anything in the spec; just know that this is why DEV is "already open".

## Layer 2 — App login (central identity provider, external redirect)

The app's login lives on a **central web on another origin**: opening the app (or
pressing its login button) **redirects there**, the username and password are
entered (`DEV_TEST_USER`/`DEV_TEST_PASS`), and on success it **redirects back to
the app**. Cross-origin works within the same browser context.

**Operator-declared flow.** When `e2e/.qa/auth.local.json` exists, the operator
declared this flow in the app config (login URL, optional certificate-step
button, form selectors, a logged-in marker). `authenticate()` already runs it —
including two-step forms, a still-valid central session that bounces straight
back, and one login per worker reused across tests. In that case:

- call `await authenticate()` in every test that needs a session, and nothing else;
- **never** edit `authenticate()` or write login steps (goto the login page, fill
  credentials) inside a spec;
- when exploring DEV with the browser tools, follow the same declared flow: the
  login page is the one under `loginUrl`; if it offers a certificate login, use
  the username/password alternative (`passwordEntry`).

**No declared flow.** Without that file, `authenticate()` runs a default flow
(login button → Keycloak-style form → back to the app): **adjust the selectors**
to the real login (the app's button and, in Keycloak, usually `#username`,
`#password`, `#kc-login`).

```ts
test("private area visible after login", async ({ page, authenticate }) => {
  await authenticate();
  await expect(page.getByRole("heading", { name: /my profile/i })).toBeVisible();
});
```

## Public pages (no login)

The app has public navigation. For those tests **do not call `authenticate()`**
(you will still pass layer 1, which belongs to the environment).

## Optimization: cache the session with storageState

With an operator-declared flow the session is already reused per worker — skip
this section. Otherwise the login is slow; to avoid repeating it in every test, do
it **once** in a setup and save the state, then reuse it:

```ts
// auth.setup.ts (a setup project)
import { test as setup } from "../fixtures";
setup("login", async ({ page, authenticate, context }) => {
  await authenticate();
  await context.storageState({ path: "e2e/.auth/user.json" });
});
```
Then authenticated tests use `test.use({ storageState: "e2e/.auth/user.json" })`.
Add `.auth/` to the e2e project's `.gitignore` (it is session state, not code).
