# Qayaba Console — standalone dashboard

The QA control panel for the Qayaba / **ai-pipeline** engine: a Fleet mission-control
overview, the runs feed, run detail + the **live run**, per-app **App Value**, integrity,
the learning ledger, and reports.

This is a **self-contained, framework-agnostic build** — plain `index.html` + CSS + vanilla JS,
no bundler, no runtime framework. It runs standalone on mock data and is built to drop into
**`ai-pipeline/web/`**, where it connects to the orchestrator's `/api/v1/*` API for real data.

```
qayaba-console/
├── index.html          # the shell (loads everything; carries the optional config)
├── styles/
│   └── console.css      # self-contained: design tokens + base + the whole console UI
├── js/
│   ├── data.mock.js     # window.QayabaMockData — the offline dataset
│   ├── api.js           # the ONE data seam: mock + live adapters (mirrors @ai-pipeline/sdk)
│   └── console.js       # the app (rendering, routing, interactions) — never fetches directly
├── assets/              # brand marks + favicon
├── API.md               # ← endpoint requirements + field mapping + gaps (read this)
└── README.md
```

Fonts (Archivo + JetBrains Mono) and Lucide icons load from CDN — see *Offline* below to vendor them.

## Run it standalone (mock)

No build step. Serve the folder with any static server:

```bash
python3 -m http.server 4330 --directory qayaba-console
# → http://localhost:4330
```

Defaults to `mode: 'mock'`: everything (incl. the live-run stream and Ask-Qayaba chat) is
simulated locally from `js/data.mock.js`.

## Connect to a server (live)

Set the config **before** the scripts run — uncomment the block in `index.html`:

```html
<script>
  window.QAYABA_CONSOLE_CONFIG = {
    mode: 'live',      // 'mock' | 'live'
    baseUrl: '',       // '' = same-origin (recommended); the browser carries the operator's creds
    token: null,       // optional Bearer token if the host isn't cookie-authed
    landingUrl: '/',   // where the sidebar brand links (your marketing site)
  };
</script>
```

In `live` mode `js/api.js` talks to `/api/v1/*` and the SSE feed (`/api/v1/runs/:id/events`),
mapping the contract onto the dashboard's view model. **The server side is not 100% there yet** —
`API.md` lists exactly which endpoints exist, which need extending, and which are new, and
`js/api.js#mapModel` has matching `TODO(server)` markers.

## Integrate into ai-pipeline (`web/`)

`ai-pipeline/web/` is the prepared slot: it builds to `web/dist` and is served same-origin at
`/app` by `src/server/static.ts`. Two ways to wire this in:

**A. Drop-in static (fastest).** Copy these files to `ai-pipeline/web/dist/` (so `web/dist/index.html`
exists). The orchestrator serves them at `/app` immediately. Set `mode:'live'` in `index.html`.
Asset/script paths are all relative, so they resolve correctly under `/app/`.

**B. Through the workspace build (contract-true).** Move this into `ai-pipeline/web/` and have the
web build emit it into `web/dist`. Optionally replace `js/api.js`'s live adapter with the real
`@ai-pipeline/sdk` (`createClient({ baseUrl: '' })`) — the adapter is intentionally a 1:1 mirror
of the SDK methods, so this is mechanical. The SDK keeps you type-safe against the contract.

Either way: implement/extend the endpoints in **API.md**, then the dashboard is live. No CORS
(same origin); the API stays Bearer-protected, only the static shell is public.

## Notes

- **Routing.** Client routes use `?run=<id>` and `#<section>` on whatever path it's mounted at
  (`/app`), with History API. `?run=<id>` deep-links a run (the landing's "live engine" link can
  point here). The orchestrator's `/app/*` → `index.html` fallback already supports this.
- **Offline / air-gapped.** Replace the Google Fonts `@import` at the top of `styles/console.css`
  with self-hosted `@font-face`, and swap the Lucide CDN `<script>` in `index.html` for a vendored
  copy. Nothing else is remote.
- **Accessibility / motion.** Honors `prefers-reduced-motion`. App-shell layout (sidebar + topbar
  fixed, content scrolls inside) — no layout shift on navigation.

## Relationship to qayaba-web

This dashboard currently also lives inside `qayaba-web` (`/dashboard`) so the marketing site can
demo it today. That copy is **superseded by this package**. Once ai-pipeline serves the console at
`/app`, point the landing's "console" links there and remove `qayaba-web`'s
`src/pages/dashboard.astro`, `src/styles/dashboard.css`, and `public/dashboard/`.
