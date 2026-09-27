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

```ts
test("private area visible after login", async ({ page, authenticate }) => {
  await authenticate();
  await expect(page.getByRole("heading", { name: /my profile/i })).toBeVisible();
});
```

When the seed locators miss the real login page, rewrite `e2e/auth.setup.ts`
from that page. Import `{ test as setup }` from `@playwright/test`, not from
`./fixtures`. Credentials stay `process.env.DEV_TEST_USER` and
`process.env.DEV_TEST_PASS`. Never write the password into the spec. Delete the
first-line seed marker (`/* qa-auth-setup-seed */`) when you rewrite the file;
that marker is what still marks it as the stock seed. Wait until the password
field is hidden — cookies are often set on the redirect — and only then call
`storageState`. `storageState` keeps cookies, localStorage, and IndexedDB.
Session storage is not included; if this app keeps the session there, save and
restore it in `auth.setup.ts`.

A software client certificate (mTLS) is applied by the orchestrator before the
browser opens. There is no selector for it.

## Public pages (no login)

The app has public navigation. For those tests **do not call `authenticate()`**
(you will still pass layer 1, which belongs to the environment).

## Session file

`.auth/` is session state (cookies, and a client certificate when the app uses
one). It is gitignored. Do not commit it. A public page resets storage with
`test.use({ storageState: { cookies: [], origins: [] } })`.
