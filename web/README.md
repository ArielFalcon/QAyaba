# @qayaba/web — operator/value dashboard

The web dashboard for qayaba: a Fleet mission-control overview, the runs feed, run detail
+ the live run, per-app App Value, integrity, the learning ledger, and reports.

## How it fits

- The implementation lives in **`web/public/`** — a self-contained, framework-agnostic
  build (plain `index.html` + CSS + vanilla JS, no bundler, no build step). See
  `web/public/README.md` for how it's structured and how to run it standalone on mock
  data, and `web/public/API.md` for the endpoint requirements the live adapter needs.
- Served **same-origin** by the orchestrator at **`/app`** (`src/server/static.ts`,
  `resolveDashboardDir`: `web/public` is preferred whenever it exists). No CORS; the
  browser carries the operator's existing credentials.
- Talks only to `/api/v1/*` and the SSE live feed (`/api/v1/runs/:id/events`). Two
  adapters implement the same interface (`web/public/js/api.js`): **live** (the default —
  talks to the real API, hand-written to mirror `@qayaba/sdk`'s `createClient()`
  method-for-method so a future swap to the generated SDK is mechanical) and **mock**
  (offline, simulated from `js/data.mock.js`, selected with
  `window.QAYABA_CONSOLE_CONFIG = { mode: 'mock' }`).

## This workspace's role

`web/package.json` declares the `@qayaba/web` workspace. It has no dependencies and no
build step — `web/public/` is served as-is. The console's tests live in
`src/server/web-console/` (run by `npm test`).
