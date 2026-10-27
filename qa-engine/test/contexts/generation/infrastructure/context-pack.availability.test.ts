/* The pack says, as facts, why each captured route that did not show its own page at its own address did not; the Live DOM it already gave is unchanged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, PACK_HEADINGS, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { CapturedPage } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { RouteChangeEvidence, RouteNavigation } from "@contexts/generation/domain/route-availability-classifier.ts";

const nav = (route: string, finalPath: string): RouteNavigation => ({ route, captureFailed: false, settled: true, nodes: 3, finalPath, documentStatus: 200, serverRedirect: false, sessionAttached: true, runtimeError: false, passwordField: false });

/* A capture of three routes: one rendered, two sent to /home. */
function captureDeps(): ContextPackDeps {
  const pages: CapturedPage[] = [
    { route: "/orders", grounded: true, links: [], nodes: ["heading: Orders"], navigation: nav("/orders", "/orders") },
    { route: "/upload-menu/preview", grounded: false, links: [], nodes: ["heading: Home"], navigation: nav("/upload-menu/preview", "/home") },
    { route: "/login", grounded: false, links: [], nodes: ["heading: Home"], navigation: nav("/login", "/home") },
  ];
  return {
    captureDomForRoutes: async (_routes, input) => {
      input.onPages?.(pages);
      return "route /orders:\n  heading: Orders\nroute /upload-menu/preview: (redirected to /home)\nroute /login: (redirected to /home)";
    },
    domDeps: { render: async () => [] },
    log: () => {},
  };
}

const evidence = (navigation: RouteNavigation): RouteChangeEvidence =>
  navigation.route === "/upload-menu/preview" ? { declaration: { status: "changed", at: "src/app/app.routes.ts:14" }, implements: false } : { declaration: { status: "unknown" }, implements: false };

const input = { baseUrl: "http://dev.example", e2eDir: "/tmp/e2e", routes: ["/orders", "/upload-menu/preview", "/login"] };

test("the pack lists why each unavailable route was not shown, and returns the facts", async () => {
  const asked: string[][] = [];
  const pack = await buildContextPack(
    { ...input, availability: { loginPath: "/login", evidence: async (navigations) => { asked.push(navigations.map((n) => n.route)); return evidence; } } },
    captureDeps(),
  );
  const section = (pack.text ?? "").split(/^### /m).find((part) => part.startsWith(PACK_HEADINGS.availability)) ?? "";
  assert.match(section, /- \/upload-menu\/preview: with this run's session the browser ends on \/home \(client-side\)\. The change governs this route: its route table entry changed at src\/app\/app\.routes\.ts:14\./);
  assert.match(section, /- \/login: with this run's session the browser ends on \/home \(client-side\)\. Pre-existing: the app's login page sends a signed-in session away\./);
  assert.doesNotMatch(section, /\/orders/);
  assert.deepEqual(asked, [["/upload-menu/preview", "/login"]]);
  assert.equal(pack.routeAvailability?.read, 3);
  assert.deepEqual(pack.routeAvailability?.facts.map((f) => [f.route, f.basis.class]), [["/upload-menu/preview", "change-introduced"], ["/login", "pre-existing"]]);
  /* The Live DOM still carries the state line the review precheck and the brief's page cut parse. */
  assert.match(pack.text ?? "", /route \/upload-menu\/preview: \(redirected to \/home\)/);
});

test("a pack asked for no classification has no availability section and no facts, as before", async () => {
  const pack = await buildContextPack(input, captureDeps());
  assert.doesNotMatch(pack.text ?? "", new RegExp(PACK_HEADINGS.availability));
  assert.equal(pack.routeAvailability, undefined);
});

test("a capture where every route rendered asks for no change evidence", async () => {
  let asked = false;
  const deps = captureDeps();
  const allRendered: ContextPackDeps = {
    ...deps,
    captureDomForRoutes: async (_routes, captureInput) => {
      captureInput.onPages?.([{ route: "/orders", grounded: true, links: [], nodes: ["heading: Orders"], navigation: nav("/orders", "/orders") }]);
      return "route /orders:\n  heading: Orders";
    },
  };
  const pack = await buildContextPack({ ...input, routes: ["/orders"], availability: { evidence: async () => { asked = true; return evidence; } } }, allRendered);
  assert.equal(asked, false);
  assert.deepEqual(pack.routeAvailability, { read: 1, facts: [] });
});
