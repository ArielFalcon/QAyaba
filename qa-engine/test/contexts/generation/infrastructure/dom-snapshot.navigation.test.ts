/* The capture reports how each route's document arrived (its status, the server redirects that led to it, the pathname it was served at) and whether the run's session was attached, so a route that ends elsewhere can be told server-side from client-side. */
import { sharedTestExec } from "../../../support/exec-sandbox-harness.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaptureDomDeps, navigationFactsOf, navigationOf } from "@contexts/generation/infrastructure/dom-snapshot.ts";

/* A stand-in `playwright` whose navigation answers with the given document (status, redirect hops, served url) and then lands on `finalPath`. `response: null` is a navigation with no document response. */
function withFakeNavigation<T>(nav: { response: { status: number; hops: number; servedPath: string } | null; finalPath: string }, body: (e2eDir: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "fake-nav-"));
  const module = join(root, "node_modules", "playwright");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "index.js"), `
const nav = ${JSON.stringify(nav)};
let origin = "";
function requestWith(hops) { return { redirectedFrom: () => (hops > 0 ? requestWith(hops - 1) : null) }; }
const page = {
  on() {},
  goto: async (url) => { origin = new URL(url).origin; return nav.response === null ? null : { status: () => nav.response.status, request: () => requestWith(nav.response.hops), url: () => origin + nav.response.servedPath }; },
  waitForLoadState: async () => {},
  url: () => origin + nav.finalPath,
  locator: () => ({ ariaSnapshot: async () => "- heading \\"Home\\"" }),
  getByRole: () => ({ evaluateAll: async () => [] }),
  evaluate: async () => [],
};
exports.chromium = { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => {} }) };
`);
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("a route the page moved after its document loaded is a client-side redirect", { timeout: 30_000 }, async () => {
  await withFakeNavigation({ response: { status: 200, hops: 0, servedPath: "/upload-menu/preview" }, finalPath: "/home" }, async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/upload-menu/preview"]);
    assert.equal(snap?.documentStatus, 200);
    assert.equal(snap?.serverRedirects, 0);
    assert.equal(snap?.documentPath, "/upload-menu/preview");
    assert.equal(snap?.sessionAttached, false);
    assert.equal(navigationOf(snap!).serverRedirect, false);
    assert.equal(navigationOf(snap!).finalPath, "/home");
  });
});

test("a route whose document the server redirected is a server redirect", { timeout: 30_000 }, async () => {
  await withFakeNavigation({ response: { status: 200, hops: 2, servedPath: "/home" }, finalPath: "/home" }, async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/old"]);
    assert.equal(snap?.serverRedirects, 2);
    assert.equal(navigationOf(snap!).serverRedirect, true);
  });
});

test("a navigation with no document response reports no document facts and still reads the page", { timeout: 30_000 }, async () => {
  await withFakeNavigation({ response: null, finalPath: "/home" }, async (e2eDir) => {
    const [snap] = await createCaptureDomDeps(sharedTestExec()).render(e2eDir, "http://dev.example", ["/home"]);
    assert.equal(snap?.documentStatus, undefined);
    assert.equal(snap?.documentPath, undefined);
    assert.deepEqual(snap?.nodes, ["heading: Home"]);
    assert.equal(navigationOf(snap!).serverRedirect, undefined);
  });
});

test("a malformed navigation fact is dropped, a well formed one kept", () => {
  assert.deepEqual(navigationFactsOf({ documentStatus: 302.5, serverRedirects: -1, documentPath: "home", sessionAttached: "yes" }), {});
  assert.deepEqual(navigationFactsOf({ documentStatus: 9999, serverRedirects: 400, documentPath: "/a b" }), {});
  assert.deepEqual(navigationFactsOf({ documentStatus: 404, serverRedirects: 1, documentPath: "/x", sessionAttached: true }), { documentStatus: 404, serverRedirects: 1, documentPath: "/x", sessionAttached: true });
});
