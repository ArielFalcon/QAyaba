# Browser conditions: geolocation, mobile, offline

## Geolocation

The app places the user on a map and, when uploading a photo, lists **nearby
places**. It declares a deterministic default location in `dev.geolocation`, and may
declare named places there; the prompt lists both. To make a test depend on another
location, set it explicitly before the first navigation that reads it:

```ts
import { setLocation } from "../fixtures";

test("shows places near the location", async ({ page, context }) => {
  await setLocation(context, 41.3874, 2.1686);   // Barcelona
  await page.goto("/map");
  await expect(page.getByRole("list", { name: /nearby places/i })).toBeVisible();
});
```
The `geolocation` permission is already granted in the config. `setLocation` also
grants it in case the test created a new context. Call it with the exact coordinates
the assertion depends on: the authoring browser's `set_geolocation` value is context
for the run, and the suite does not see it when it runs later.

## Mobile mode

The suite's config has one browser project (desktop). Emulate a phone in the spec file itself, at the
top of the file; the pages the prompt supplies were captured at desktop size, so read the mobile page in a
`run_spec` report before you trust a selector there:

```ts
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("the menu collapses on mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /menu/i })).toBeVisible();
});
```

## Offline mode

```ts
import { goOffline, goOnline } from "../fixtures";

test("shows an offline notice", async ({ page, context }) => {
  await page.goto("/");
  await goOffline(context);
  await page.getByRole("button", { name: /reload/i }).click();
  await expect(page.getByText(/no connection/i)).toBeVisible();
  await goOnline(context);   // restore for teardown
});
```
Always go back online before finishing so teardown does not break.
