/* Central login (e2e.auth): the materialized declaration, the DOM capture that logs in before grounding, the off-origin guard, and the seed fixture that runs the same flow in the watched repo. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRouteCatalog } from "@contexts/generation/infrastructure/route-catalog.ts";
import { buildCaptureScript, createCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { AUTH_MATERIAL_FILES } from "../../../../src/shared-infrastructure/process-sandbox/auth-session-env.ts";
import { SetupAdapter, type SetupAdapterFsDeps } from "@contexts/workspace-and-publication/infrastructure/setup.adapter.ts";
import { E2E_AUTH_FILE } from "@kernel/e2e-auth.ts";
import type { SandboxedBinaryRunner } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");

test("a capture that settled on another origin is degraded even when the path matches the route", () => {
  const catalog = buildRouteCatalog({ route: "/login", nodes: ["heading: Sign in"], settled: true, finalUrl: "https://sso.example.com/login", offOrigin: true });
  assert.equal(catalog.status, "degraded");
  assert.equal(catalog.settled, false);
});

test("a same-origin capture on the requested path stays captured", () => {
  const catalog = buildRouteCatalog({ route: "/orders", nodes: ["heading: Orders"], settled: true, finalUrl: "https://app.example.com/orders" });
  assert.equal(catalog.status, "captured");
});

test("the capture script performs the declared login before snapshotting and never embeds the config", () => {
  const src = buildCaptureScript("/e2e/node_modules/playwright");
  assert.match(src, /readAuthConfig\(\)/);
  assert.match(src, new RegExp(E2E_AUTH_FILE.replace(/\./g, "\\.")));
  assert.match(src, /DEV_TEST_USER/);
  assert.ok(src.indexOf("centralLogin(page, auth") < src.indexOf("for (const route of routes)"), "login runs before the route loop");
  assert.match(src, /offOrigin/);
  assert.doesNotThrow(() => new Function(src.replace(/^const \{ chromium \} = require\([^)]*\);/, "")), "generated script must parse");
});

function memFs(existing: string[] = []): SetupAdapterFsDeps & { written: Map<string, string>; removed: string[] } {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const present = new Set(existing);
  return {
    written,
    removed,
    exists: (p) => present.has(p) || written.has(p),
    cp: () => {},
    read: () => "",
    readBytes: () => Buffer.from(""),
    write: (p, c) => void written.set(p, c),
    append: () => {},
    mkdir: () => {},
    remove: (p) => void removed.push(p),
  };
}

const neverRun: SandboxedBinaryRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) } as unknown as SandboxedBinaryRunner;

test("setup writes the declared login into the working copy", () => {
  const fs = memFs();
  const auth = { loginUrl: "https://sso.example.com/", successSelector: "[data-testid=user-menu]" };
  new SetupAdapter({ fs, runner: neverRun, seedDir: "/seed", authConfig: auth }).ensureAuthConfig("/m/e2e");
  assert.deepEqual(JSON.parse(fs.written.get(`/m/e2e/${E2E_AUTH_FILE}`) ?? "{}"), auth);
});

test("setup removes a stale login declaration when the app no longer declares one", () => {
  const fs = memFs([`/m/e2e/${E2E_AUTH_FILE}`]);
  new SetupAdapter({ fs, runner: neverRun, seedDir: "/seed" }).ensureAuthConfig("/m/e2e");
  assert.deepEqual(fs.removed, [`/m/e2e/${E2E_AUTH_FILE}`]);
});

test("the seed keeps the login declaration out of git", () => {
  const gitignore = readFileSync(join(repoRoot, "config", "e2e", ".gitignore"), "utf8");
  assert.match(gitignore, /^\.qa\/auth\.local\.json$/m);
});

test("the seed authenticate() fixture runs the declared central login and spares its traffic from fault injection", () => {
  const fixtures = readFileSync(join(repoRoot, "config", "e2e", "fixtures.ts"), "utf8");
  assert.match(fixtures, /join\(process\.cwd\(\), "\.qa", "auth\.local\.json"\)/);
  assert.match(fixtures, /const declared = readAuthConfig\(\);\s+if \(declared\) \{\s+await centralLogin\(page, declared, user, pass\);/);
  assert.match(fixtures, /loginOrigin && new URL\(route\.request\(\)\.url\(\)\)\.origin === loginOrigin\) return route\.continue\(\)/);
  assert.doesNotMatch(fixtures, /networkidle/, "the seed lint (eslint-plugin-playwright) rejects networkidle waits");
});

/* The capture runs as a child process against Playwright, so the process boundary is real and the browser is a stand-in module at <e2e>/node_modules/playwright: every navigation is appended to calls.log, a visit to the login's start path ends on the identity provider's page, and the page can be told to throw. */
const FAKE_PLAYWRIGHT = `
const fs = require("fs");
const path = require("path");
const log = (line) => fs.appendFileSync(path.join(process.cwd(), "calls.log"), line + "\\n");
let current = "about:blank";
const page = {
  on() {},
  async goto(url) {
    log("goto " + url);
    if (process.env.FAKE_GOTO_THROWS && url.endsWith("/start")) throw new Error("navigation failed for " + process.env.DEV_TEST_USER + " / " + process.env.DEV_TEST_PASS);
    current = url.endsWith("/start") ? "https://sso.example.com/login" : url;
  },
  url: () => current,
  async waitForLoadState() {},
  waitForURL: () => Promise.reject(new Error("no redirect")),
  async evaluate() { return []; },
  locator: () => ({ ariaSnapshot: async () => '- heading "Orders"' }),
};
exports.chromium = { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => {} }) };
`;

const DECLARED_LOGIN = { loginUrl: "https://sso.example.com/login", startPath: "/start" };
const TEST_USER = "capture-user";
const TEST_PASS = "capture-pass-9d41";

async function captureWith(opts: { savedSession: boolean; gotoThrows?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "qa-capture-login-"));
  const saved = { user: process.env.DEV_TEST_USER, pass: process.env.DEV_TEST_PASS, throws: process.env.FAKE_GOTO_THROWS };
  try {
    const e2eDir = join(root, "e2e");
    const authDir = join(root, "auth");
    mkdirSync(join(e2eDir, "node_modules", "playwright"), { recursive: true });
    mkdirSync(join(e2eDir, ".qa"), { recursive: true });
    mkdirSync(authDir);
    writeFileSync(join(e2eDir, "node_modules", "playwright", "index.js"), FAKE_PLAYWRIGHT);
    writeFileSync(join(e2eDir, E2E_AUTH_FILE), JSON.stringify(DECLARED_LOGIN));
    if (opts.savedSession) writeFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), "{}");
    process.env.DEV_TEST_USER = TEST_USER;
    process.env.DEV_TEST_PASS = TEST_PASS;
    if (opts.gotoThrows) process.env.FAKE_GOTO_THROWS = "1";
    else delete process.env.FAKE_GOTO_THROWS;
    const snaps = await createCaptureDomDeps(authDir).render(e2eDir, "https://app.example.com", ["/orders"]);
    let calls = "";
    try { calls = readFileSync(join(e2eDir, "calls.log"), "utf8"); } catch { /* no navigation happened */ }
    return { snaps, calls };
  } finally {
    for (const [name, value] of [["DEV_TEST_USER", saved.user], ["DEV_TEST_PASS", saved.pass], ["FAKE_GOTO_THROWS", saved.throws]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("the capture runs the declared central login when no session was saved", { timeout: 30_000 }, async () => {
  const { calls } = await captureWith({ savedSession: false });
  assert.ok(calls.includes("/start"), "the login flow was started");
});

test("the capture does not run the declared central login when a saved session is loaded", { timeout: 30_000 }, async () => {
  const { snaps, calls } = await captureWith({ savedSession: true });
  assert.equal(calls.includes("/start"), false, "the seed authenticate() returns early for a saved session, and so does the capture");
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]?.route, "/orders");
});

test("a central login that failed is reported on every snapshot instead of on an ignored stream, without the credentials", { timeout: 30_000 }, async () => {
  const { snaps } = await captureWith({ savedSession: false, gotoThrows: true });
  assert.equal(snaps.length, 1);
  const failure = snaps[0]?.loginError ?? "";
  assert.notEqual(failure, "", "the failure travels with the capture result");
  assert.equal(failure.includes(TEST_PASS) || failure.includes(TEST_USER), false, "the failure never carries the credentials");
});

test("a central login that is still on the login page afterwards is reported as a failure", { timeout: 30_000 }, async () => {
  const { snaps } = await captureWith({ savedSession: false });
  assert.notEqual(snaps[0]?.loginError ?? "", "");
});
