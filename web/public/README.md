# Qayaba Console — standalone dashboard

The QA control panel for the Qayaba / **ai-pipeline** engine: a Fleet mission-control
overview, the runs feed, run detail + the **live run**, per-app **App Value**, integrity,
the learning ledger, and reports.

This is a **self-contained, framework-agnostic console** — plain `index.html` + CSS + vanilla JS,
no bundler, no build step, no runtime framework. The orchestrator serves this directory as-is,
same-origin, at **`/app`** (`src/server/static.ts`), where it talks to the `/api/v1/*` API for real
data. It can also run standalone on mock data.

```
web/public/
├── index.html          # the shell (loads everything; carries the optional config)
├── styles/
│   └── console.css      # self-contained: design tokens + base + the whole console UI
├── js/
│   ├── data.mock.js     # window.QayabaMockData — the offline dataset
│   ├── format.js        # window.QayabaFormat — pure formatting helpers
│   ├── api.js           # the ONE data seam: mock + live adapters (mirrors @qayaba/sdk)
│   └── console.js       # the app (rendering, routing, interactions) — never fetches directly
├── assets/              # brand marks + favicon
├── API.md               # ← endpoint requirements + field mapping + gaps (read this)
└── README.md
```

Fonts (Archivo + JetBrains Mono) and Lucide icons load from CDN — see *Offline* below to vendor them.

## Configuration

`js/api.js` defaults to **`mode: 'live'`**. Override it by setting the config **before** the
scripts run (a `<script>` block in `index.html`, above `js/data.mock.js`):

```html
<script>
  window.QAYABA_CONSOLE_CONFIG = {
    mode: 'live',      // 'live' (default) | 'mock'
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

In `mock` mode everything (incl. the live-run stream and Ask-Qayaba chat) is simulated locally
from `js/data.mock.js` — no server needed.

## How the orchestrator serves it

`src/server/static.ts` serves `web/public/` at `/app` (with the `/app/*` → `index.html` fallback for
client routes). There is nothing to build: edit a file and reload. `docker-compose.override.yml`
bind-mounts `web/` into the orchestrator for local work; without it the image's copy is served.

## Run it standalone (mock)

`index.html` loads its scripts from `/app/js/…`, so serve the directory under `/app` — for example:

```bash
mkdir -p /tmp/qayaba-console && ln -sfn "$PWD/web/public" /tmp/qayaba-console/app
python3 -m http.server 4330 --directory /tmp/qayaba-console
# → http://localhost:4330/app/  (set mode: 'mock' as above)
```

## Notes

- **Routing.** Client routes use `?run=<id>` and `#<section>` on whatever path it's mounted at
  (`/app`), with History API. `?run=<id>` deep-links a run (the landing's "live engine" link can
  point here). The orchestrator's `/app/*` → `index.html` fallback already supports this.
- **Offline / air-gapped.** Nothing is remote: the fonts (`@font-face` in `styles/console.css`) and the
  Lucide icons are vendored under `vendor/` (sources, versions, licenses and hashes in
  `vendor/README.md`), and the orchestrator serves the console under a content security policy that
  allows only its own origin (`src/server/static.ts`). Keep it that way: no inline `<script>`, no inline
  event handler, no CDN reference.
- **Accessibility / motion.** Honors `prefers-reduced-motion`. App-shell layout (sidebar + topbar
  fixed, content scrolls inside) — no layout shift on navigation.

## Relationship to qayaba-web

This dashboard currently also lives inside `qayaba-web` (`/dashboard`) so the marketing site can
demo it today. That copy is **superseded by this package**. Once ai-pipeline serves the console at
`/app`, point the landing's "console" links there and remove `qayaba-web`'s
`src/pages/dashboard.astro`, `src/styles/dashboard.css`, and `public/dashboard/`.
