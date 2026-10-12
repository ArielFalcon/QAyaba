/*
 * Smoke test of the authenticated agent browser against a local test server, with the REAL parts: the sandboxed browser
 * launcher, the guarded Playwright context and playwright-core. `npx tsx scripts/agent-browser-smoke.ts` on a host with
 * Chromium, or, to run it as the sandbox uid the way production does, inside the orchestrator image:
 *   docker run --rm --entrypoint npx <orchestrator image> tsx scripts/agent-browser-smoke.ts
 *
 * It proves what the unit tests can only assume about the browser: the session reaches the page from memory (the server sees
 * the cookie) and is written nowhere; a form POST and a fetch POST never reach the server; a denied route and an undeclared
 * origin are never requested; a service worker cannot register; and the browser process is gone when the host closes.
 * Exit 0 only when every check passed. It touches no DEV and needs no credentials.
 */

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildScriptExec } from "../src/server/exec-sandbox-factory.ts";
import { ProcessKillAdapter } from "../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { resolveSandbox } from "../qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts";
import { createRouteGuard } from "../qa-engine/src/contexts/test-execution/domain/agent-browser-route-guard.ts";
import { PlaywrightAgentBrowserHost } from "../qa-engine/src/contexts/test-execution/infrastructure/agent-browser/playwright-agent-browser.host.ts";
import { SandboxedChromiumLauncher } from "../qa-engine/src/contexts/test-execution/infrastructure/agent-browser/chromium-sandbox.launcher.ts";
import { loadPlaywrightChromium } from "../qa-engine/src/contexts/test-execution/infrastructure/agent-browser/playwright-core.loader.ts";
import type { BlockedRequest } from "../qa-engine/src/contexts/test-execution/application/ports/agent-browser.ports.ts";

const SESSION_VALUE = "sess-9f3a1c7e";
const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

const hits = { cookieOnHome: "", posts: 0, admin: 0, swScript: 0, otherOrigin: 0 };

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.size < 64 * 1024 * 1024) out.push(path);
  }
  return out;
}

async function main(): Promise<number> {
  const other = await listen((req, res) => { hits.otherOrigin += 1; res.writeHead(200).end("gif"); });
  const app = await listen((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "POST") { hits.posts += 1; res.writeHead(200).end("deleted"); return; }
    if (url.startsWith("/admin")) { hits.admin += 1; res.writeHead(200).end("<h1>Admin</h1>"); return; }
    if (url === "/sw.js") { hits.swScript += 1; res.writeHead(200, { "content-type": "text/javascript" }).end("self.addEventListener('fetch',()=>{});"); return; }
    if (url === "/") hits.cookieOnHome = String(req.headers.cookie ?? "");
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Home</title><h1>Home</h1>
      <a href="/orders">Orders</a> <a href="/admin/users">Admin</a>
      <form method="post" action="/api/delete"><button>Delete</button></form>
      <button onclick="fetch('/api/delete',{method:'POST'})">Fetch delete</button>
      <p id="sw">sw:pending</p><img alt="tracker" src="http://127.0.0.1:${other.port}/pixel.gif">
      <script>
        const show = async () => { const regs = await navigator.serviceWorker.getRegistrations(); document.getElementById('sw').textContent = 'registrations:' + regs.length; };
        Promise.allSettled([
          navigator.serviceWorker.register('/sw.js'),
          Object.getPrototypeOf(navigator.serviceWorker).register.call(navigator.serviceWorker, '/sw.js'),
        ]).then(() => new Promise((r) => setTimeout(r, 500))).then(show);
      </script>`);
  });
  const origin = `http://127.0.0.1:${app.port}`;

  const sandbox = resolveSandbox(process.env);
  const scriptExec = buildScriptExec(process.env, sandbox);
  const seen: BlockedRequest[] = [];
  let workDir = "";
  try {
    await scriptExec.scoped({ runId: `agent-browser-smoke-${process.pid}`, devOrigins: [origin] }, async () => {
      workDir = scriptExec.exec.workDir();
      const launcher = new SandboxedChromiumLauncher({
        exec: scriptExec.exec,
        chromium: loadPlaywrightChromium,
        kill: new ProcessKillAdapter(),
        ...(process.platform === "linux" ? { ttlWrapper: { command: "timeout", seconds: 600 } } : {}),
      });
      const host = new PlaywrightAgentBrowserHost({
        launcher,
        material: async () => ({ storageState: { cookies: [{ name: "sid", value: SESSION_VALUE, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] } }),
        guard: createRouteGuard({ origins: [origin], denyRoutes: ["/admin/**"], allowMutating: [] }),
      });
      const options = { signal: new AbortController().signal, timeoutMs: 30_000 };
      try {
        const home = await host.perform("s1", { kind: "navigate", url: `${origin}/` }, options);
        seen.push(...home.blocked);
        check(home.snapshot.includes("Home") && /\[ref=/.test(home.snapshot), "the page is read through the accessibility tree with refs");
        check(hits.cookieOnHome.includes(`sid=${SESSION_VALUE}`), "the saved session reaches the page from memory (the server saw the cookie)");

        await new Promise((r) => setTimeout(r, 1500));
        const later = await host.perform("s1", { kind: "snapshot" }, options);
        seen.push(...later.blocked);
        check(later.snapshot.includes("registrations:0") && hits.swScript === 0, "a service worker cannot be registered, by the instance or through the prototype, and its script is never requested");
        check(hits.otherOrigin === 0, "a subresource on an undeclared origin is never requested");

        const formRef = /button "Delete" \[ref=(\w+)\]/.exec(later.snapshot)?.[1];
        check(formRef !== undefined, "the buttons are listed with refs");
        let afterForm = later;
        if (formRef) {
          afterForm = await host.perform("s1", { kind: "click", ref: formRef }, options);
          seen.push(...afterForm.blocked);
        }
        check(afterForm.url.startsWith(origin) && afterForm.notes.some((n) => /reopened/.test(n)), "a blocked form submission leaves the agent on the page it was on, with a note, not on the browser's error page");
        const fetchRef = /button "Fetch delete" \[ref=(\w+)\]/.exec(afterForm.snapshot)?.[1];
        if (fetchRef) seen.push(...(await host.perform("s1", { kind: "click", ref: fetchRef }, options)).blocked);
        check(hits.posts === 0, "a form POST and a fetch POST never reach the server");
        check(seen.filter((b) => b.reason === "method").length >= 2, "both writes are reported to the agent as blocked");

        const admin = await host.perform("s1", { kind: "navigate", url: `${origin}/admin/users` }, options);
        seen.push(...admin.blocked);
        check(hits.admin === 0 && admin.blocked.some((b) => b.reason === "deny-route"), "a denied route is never requested and is reported as blocked");
        check(seen.some((b) => b.reason === "origin"), "the undeclared origin is reported as blocked");
      } finally {
        await host.close();
      }
      const leaked = filesUnder(workDir).filter((file) => {
        try { return readFileSync(file).includes(SESSION_VALUE); } catch { return false; }
      });
      check(leaked.length === 0, `the session value is written to no file of the run's work dir${leaked.length ? ` (found in ${leaked.join(", ")})` : ""}`);
      let alive = false;
      try { alive = execFileSync("pgrep", ["-f", "remote-debugging-port"], { encoding: "utf8" }).trim() !== ""; } catch { alive = false; }
      check(!alive, "no browser process is left once the host is closed");
    });
  } catch (err) {
    check(false, `the smoke could not complete: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    app.server.close();
    other.server.close();
  }
  console.log(failures.length === 0 ? "\nagent browser smoke: OK" : `\nagent browser smoke: ${failures.length} check(s) FAILED`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(await main());
