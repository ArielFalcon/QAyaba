# Asserting a route that sends the browser away

Read this when the prompt's **Route availability** section lists a route your flow opens.
The orchestrator captured that route with this run's own client and saw it end somewhere
else (a redirect, or an HTTP error), and it says why.

- **The change sends the route away** (a route declaration or a route guard of this change):
  that redirect IS the behaviour under test. Open the route and assert where it ends, with a
  web-first URL assertion and one element of the page it lands on:

  ```ts
  await page.goto(GOVERNED_ROUTE);
  await expect(page).toHaveURL(LANDING_ROUTE_PATTERN);
  await expect(page.getByRole("heading", { name: LANDING_HEADING })).toBeVisible();
  ```

  Never assert the page the route no longer shows to this client: it will not render.
- **Not caused by this change** (its route entry and guards are unchanged, or the login page
  sends a signed-in session away): the route was like this before the change. Do not test
  the page behind it; reach the change through a page that does render.
- **Environment** (no session, a DEV gate, missing data): the run cannot reach the page.
  Say so in your verdict; do not write a test that only meets the environment.
- **Possible regression** or **unexplained**: report it; never write a test that makes the
  redirect pass as expected behaviour.

Constants above are placeholders: take the routes from the section, and the landing page's
locators from its Live DOM, never from this file.
