/* Central login (e2e.auth): the materialized declaration, the DOM capture that logs in before grounding, the off-origin guard, and the seed fixture that runs the same flow in the watched repo. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRouteCatalog } from "@contexts/generation/infrastructure/route-catalog.ts";
import { buildCaptureScript } from "@contexts/generation/infrastructure/dom-snapshot.ts";
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
