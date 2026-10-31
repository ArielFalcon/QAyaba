/*
 * Serves the web console (web/public — plain HTML/CSS/JS, no build step) same-origin at /app so it
 * shares the orchestrator origin — no CORS. Reads are confined to that directory (path traversal).
 * The API stays Bearer-protected; only the static shell is public.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const PLACEHOLDER =
  '<!doctype html><meta charset="utf-8"><title>qayaba · dashboard</title>' +
  '<body style="font-family:system-ui;background:#14100e;color:#f5f1ee;display:grid;place-items:center;height:100vh;margin:0">' +
  '<div style="text-align:center;max-width:32rem;padding:1rem">' +
  '<h1 style="font-weight:500">qayaba · dashboard</h1>' +
  '<p style="color:#b9aea6">The web console is missing: <code>web/public/index.html</code> was not found in this install.</p>' +
  "</div></body>";

export interface ServeDashboardOptions {
  dir: string;
}

/* The console's directory under the install root. It is served as-is: there is no build output. */
export function resolveDashboardDir(root: string): string {
  return join(root, "web", "public");
}

/* Cache by (path, mtime) so a bind-mounted web/public can change while the process lives. */
interface CachedFile {
  mtimeMs: number;
  body: Buffer;
}
interface DirCache {
  index: CachedFile | null;
  assets: Map<string, CachedFile>;
}
const dirCaches = new Map<string, DirCache>();

function cacheFor(dir: string): DirCache {
  let c = dirCaches.get(dir);
  if (!c) {
    c = { index: null, assets: new Map() };
    dirCaches.set(dir, c);
  }
  return c;
}

function readFresh(file: string, cached: CachedFile | null | undefined): CachedFile {
  const mtimeMs = statSync(file).mtimeMs;
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  return { mtimeMs, body: readFileSync(file) };
}

export async function serveDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeDashboardOptions,
): Promise<boolean> {
  const url = (req.url ?? "/app").split("?")[0] ?? "/app";
  const index = join(opts.dir, "index.html");

  if (!existsSync(index)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PLACEHOLDER);
    return true;
  }

  let rel = url.replace(/^\/app/, "");
  if (rel === "" || rel === "/") rel = "/index.html";

  /* Confine to the console's directory — never serve outside it (path traversal). */
  const root = normalize(opts.dir);
  const resolved = normalize(join(opts.dir, rel));
  if (resolved !== root && !resolved.startsWith(root + "/") && !resolved.startsWith(root + "\\")) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return true;
  }

  const cache = cacheFor(opts.dir);
  const file = existsSync(resolved) && statSync(resolved).isFile() ? resolved : index;

  let body: Buffer;
  if (file === index) {
    const fresh = readFresh(index, cache.index);
    cache.index = fresh;
    body = fresh.body;
  } else {
    const fresh = readFresh(file, cache.assets.get(file));
    cache.assets.set(file, fresh);
    body = fresh.body;
  }

  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
  return true;
}
