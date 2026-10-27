import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { routeChangeEvidence } from "@contexts/generation/infrastructure/adapters/route-change-evidence.ts";
import { classifyRouteAvailability, type RouteNavigation } from "@contexts/generation/domain/route-availability-classifier.ts";
import type { ChangeClosure } from "@kernel/route-availability.ts";

const PACKAGE = JSON.stringify({ dependencies: { "@angular/core": "20.0.0", "@angular/router": "20.0.0" } });

/* A settled read of `/login` that the browser left for `/home` client-side, with the run's session. */
const navigation: RouteNavigation = {
  route: "/login",
  captureFailed: false,
  settled: true,
  nodes: 12,
  finalPath: "/home",
  documentStatus: 200,
  serverRedirect: false,
  sessionAttached: true,
  runtimeError: false,
  passwordField: false,
};

interface Scenario {
  /* The working copy at head, by repository-relative path. */
  head: Record<string, string>;
  /* The files the change touched at the base, by path; a file absent here did not exist there. */
  base?: Record<string, string>;
  changed: string[];
  closure?: ChangeClosure;
}

/* Runs the change evidence over a scratch working copy and classifies the `/login` redirect with it, the way the grounding does. */
async function classifyWith(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), "route-change-evidence-"));
  try {
    for (const [file, text] of Object.entries({ "package.json": PACKAGE, ...scenario.head })) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const base = scenario.base ?? {};
    const evidenceOf = await routeChangeEvidence({
      mirrorDir: dir,
      changedFiles: scenario.changed,
      baseRef: "base",
      readAtRef: async (_ref, file) => base[file],
      ...(scenario.closure !== undefined ? { closure: async () => scenario.closure } : {}),
      crossRepo: false,
    });
    return classifyRouteAvailability({ navigation, evidence: evidenceOf(navigation), context: { controlRendered: true } })?.basis;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GUARD_FILE = "src/app/auth/guest.guard.ts";
const GUARD = "export const guestGuard = () => true;\n";
const routesImporting = (importLine: string, guard: string): string =>
  [
    "import { Routes } from '@angular/router';",
    importLine,
    "",
    "export const routes: Routes = [",
    `  { path: 'login', canActivate: [${guard}], component: LoginPage },`,
    "  { path: 'home', component: HomePage },",
    "];",
    "",
  ].join("\n");

/* The change edits the guard's own file; the route table is the same at the base and at head. */
const guardChanged: ChangeClosure = { symbols: [{ file: GUARD_FILE, symbol: "guestGuard" }], complete: true };

test("a guard imported through a barrel is not placed at the barrel: the route stays unexplained, never pre-existing", async () => {
  const routes = routesImporting("import { guestGuard } from './auth';", "guestGuard");
  const basis = await classifyWith({
    head: { "src/app/app.routes.ts": routes, "src/app/auth/index.ts": "export { guestGuard } from './guest.guard';\n", [GUARD_FILE]: GUARD },
    base: { [GUARD_FILE]: GUARD },
    changed: [GUARD_FILE],
    closure: guardChanged,
  });
  assert.equal(basis?.class, "unexplained");
  assert.ok(basis?.class === "unexplained" && basis.missing.includes("guard-reach"));
});

test("a guard imported under another local name is placed by the name its file declares", async () => {
  const routes = routesImporting("import { guestGuard as g } from './auth/guest.guard';", "g");
  const basis = await classifyWith({
    head: { "src/app/app.routes.ts": routes, [GUARD_FILE]: GUARD },
    base: { [GUARD_FILE]: GUARD },
    changed: [GUARD_FILE],
    closure: guardChanged,
  });
  assert.deepEqual(basis, { class: "change-introduced", via: "route-guard", at: `${GUARD_FILE}::guestGuard` });
});
