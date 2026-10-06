# Authentication (two layers)

This app has **two distinct credentials**. Do not confuse them.

## Layer 1 — DEV environment gate (HTTP Basic Auth)

The whole DEV environment is protected by the browser's native dialog
(username/password). **You do not interact with that dialog**: it is handled by
`httpCredentials`, already configured in `playwright.config.ts` from
`DEV_ENV_USER`/`DEV_ENV_PASS` and scoped to the app origin. You do not need to do
anything in the spec; just know that this is why DEV is "already open".

## Layer 2 — App login (form)

The app login is `e2e/auth.setup.ts` (Playwright's setup project). The orchestrator
runs that project before grounding and again before execute, then points the suite
at the saved session with `PW_STORAGE_STATE`. Desktop does not depend on the setup
project, so the suite does not log in a second time. Specs call `authenticate()`
and do not repeat the form. One shared account is enough: the suite runs with a
single worker.

**Operator-declared central login.** When `e2e/.qa/auth.local.json` exists, the operator
declared in the app config a login on a **central web on another origin**: opening the
app (or pressing its login button) **redirects there**, the username and password are
entered (`DEV_TEST_USER`/`DEV_TEST_PASS`), and on success it **redirects back to the
app**. The file holds the login URL, an optional certificate-step button, form
selectors and a logged-in marker. When the orchestrator did not save a session
(`PW_STORAGE_STATE` unset), `authenticate()` already runs that flow — including
two-step forms, a still-valid central session that bounces straight back, and one
login per worker reused across tests. In that case:

- call `await authenticate()` in every test that needs a session, and nothing else;
- **never** edit `authenticate()`, rewrite `e2e/auth.setup.ts` for this login, or write
  login steps (goto the login page, fill credentials) inside a spec;
- when exploring DEV with the browser tools, follow the same declared flow: the
  login page is the one under `loginUrl`; if it offers a certificate login, use
  the username/password alternative (`passwordEntry`).

```ts
test("private area visible after login", async ({ page, authenticate }) => {
  await authenticate();
  await expect(page.getByRole("heading", { name: /my profile/i })).toBeVisible();
});
```

Without a declared flow, when the seed locators miss the real login page, rewrite
`e2e/auth.setup.ts` from that page. Import `{ test as setup }` from `@playwright/test`, not from
`./fixtures`. Credentials stay `process.env.DEV_TEST_USER` and
`process.env.DEV_TEST_PASS`. Never write the password into the spec. Delete the
first-line seed marker (`/* qa-auth-setup-seed */`) when you rewrite the file.
Only a byte-for-byte shipped seed is the stock seed: once you change a byte, the
file is the app's own login, setup never replaces it, and a sign-in it cannot
complete fails the run instead of running unauthenticated. Wait until the password
field is hidden — cookies are often set on the redirect — and only then call
`storageState`. `storageState` keeps cookies, localStorage, and IndexedDB.
Session storage is not included; if this app keeps the session there, save and
restore it in `auth.setup.ts`.

Keep the seed's session path when you rewrite it: save to
`process.env.PW_STORAGE_STATE`, which the orchestrator sets to a directory
outside the repository and reads the session from. A rewrite that saves anywhere
else fails the run before the tests execute.

```ts
const authFile = process.env.PW_STORAGE_STATE ?? ".auth/user.json";
// … fill the form, wait for the password field to be hidden …
await page.context().storageState({ path: authFile });
```

A software client certificate (mTLS) is applied by the orchestrator before the
browser opens. There is no selector for it.

## Public pages (no login)

The app has public navigation. For those tests **do not call `authenticate()`**
(you will still pass layer 1, which belongs to the environment).

## Session file

`.auth/` is session state (cookies, and a client certificate when the app uses
one). It is gitignored. Do not commit it. A public page resets storage with
`test.use({ storageState: { cookies: [], origins: [] } })`.

With an operator-declared central login the session is already reused per worker: there is nothing to save.
