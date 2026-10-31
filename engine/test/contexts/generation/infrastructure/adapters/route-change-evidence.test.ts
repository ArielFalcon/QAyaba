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
  /* The route the capture opened; `/login` by default. */
  route?: string;
  crossRepo?: boolean;
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
      crossRepo: scenario.crossRepo ?? false,
    });
    const opened = { ...navigation, route: scenario.route ?? navigation.route };
    return classifyRouteAvailability({ navigation: opened, evidence: evidenceOf(opened), context: { controlRendered: true } })?.basis;
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

test("a guard imported through a barrel is the guard of the file that declares it, never of the barrel", async () => {
  const routes = routesImporting("import { guestGuard } from './auth';", "guestGuard");
  const basis = await classifyWith({
    head: { "src/app/app.routes.ts": routes, "src/app/auth/index.ts": "export { guestGuard } from './guest.guard';\n", [GUARD_FILE]: GUARD },
    base: { [GUARD_FILE]: GUARD },
    changed: [GUARD_FILE],
    closure: guardChanged,
  });
  assert.deepEqual(basis, { class: "change-introduced", via: "route-guard", at: `${GUARD_FILE}::guestGuard` });
});

test("a guard whose barrel chain ends nowhere is unplaced: the route stays unexplained, never pre-existing", async () => {
  const routes = routesImporting("import { guestGuard } from './auth';", "guestGuard");
  const run = (barrel: string, extra: Record<string, string> = {}) =>
    classifyWith({
      head: { "src/app/app.routes.ts": routes, "src/app/auth/index.ts": barrel, [GUARD_FILE]: GUARD, ...extra },
      base: { [GUARD_FILE]: GUARD },
      changed: [GUARD_FILE],
      closure: guardChanged,
    });
  /* The barrel re-exports from a module that does not exist. */
  const missing = await run("export { guestGuard } from './gone.guard';\n");
  assert.ok(missing?.class === "unexplained" && missing.missing.includes("guard-reach"));
  /* Two modules the barrel re-exports whole declare the name: the import does not come down to one declaration. */
  const ambiguous = await run("export * from './guest.guard';\nexport * from './other.guard';\n", { "src/app/auth/other.guard.ts": "export const guestGuard = () => false;\n" });
  assert.ok(ambiguous?.class === "unexplained" && ambiguous.missing.includes("guard-reach"));
  /* A barrel that re-exports itself in a loop. */
  const loop = await run("export * from './index';\n");
  assert.ok(loop?.class === "unexplained" && loop.missing.includes("guard-reach"));
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

/* An app that imports through tsconfig `paths`: the constants and the guard live under an aliased folder, behind barrels. */
const ALIASED = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "./", paths: { "@core/*": ["src/app/core/*"] } } }),
  "src/app/core/router/models/routes.model.ts": "export enum RoutePath {\n  Home = 'home',\n  UploadMenu = 'upload-menu',\n}\n",
  "src/app/core/guards/index.ts": "export * from './native-only.guard';\n",
  "src/app/core/guards/native-only.guard.ts": "export const nativeOnlyGuard = () => isNative();\n",
  "src/app/upload/upload.routes.ts": "import { Routes } from '@angular/router';\n\nexport const UPLOAD_ROUTES: Routes = [\n  { path: 'preview', component: PreviewPage },\n];\n",
};
const aliasedRoutes = (guarded: boolean): string =>
  [
    "import { Routes } from '@angular/router';",
    "import { RoutePath } from '@core/router/models/routes.model';",
    "import { nativeOnlyGuard } from '@core/guards';",
    "",
    "export const routes: Routes = [",
    "  { path: RoutePath.Home, component: HomePage },",
    "  {",
    "    path: RoutePath.UploadMenu,",
    ...(guarded ? ["    canMatch: [nativeOnlyGuard],"] : []),
    "    loadChildren: () => import('./upload/upload.routes').then((m) => m.UPLOAD_ROUTES),",
    "  },",
    "];",
    "",
  ].join("\n");
const ROUTES_FILE = "src/app/app.routes.ts";
const GUARD_UNDER_ALIAS = "src/app/core/guards/native-only.guard.ts";

test("a guard added to an entry whose path and guard are imported through tsconfig paths introduces the route", async () => {
  const basis = await classifyWith({
    route: "/upload-menu/preview",
    head: { ...ALIASED, [ROUTES_FILE]: aliasedRoutes(true) },
    base: { [ROUTES_FILE]: aliasedRoutes(false) },
    changed: [ROUTES_FILE],
  });
  assert.ok(basis?.class === "change-introduced");
  assert.equal(basis.via, "route-declaration");
  assert.match(basis.at, new RegExp(`^${ROUTES_FILE}:`));
});

test("a guard reached through an aliased barrel is the guard of its declaring file, which the change reaches", async () => {
  const basis = await classifyWith({
    route: "/upload-menu/preview",
    head: { ...ALIASED, [ROUTES_FILE]: aliasedRoutes(true) },
    base: { [ROUTES_FILE]: aliasedRoutes(true) },
    changed: [GUARD_UNDER_ALIAS],
    closure: { symbols: [{ file: GUARD_UNDER_ALIAS, symbol: "nativeOnlyGuard" }], complete: true },
  });
  assert.deepEqual(basis, { class: "change-introduced", via: "route-guard", at: `${GUARD_UNDER_ALIAS}::nativeOnlyGuard` });
});

test("a guard behind a barrel that a complete closure does not reach is unreached at its declaring file, whatever the barrel holds", async () => {
  const unrelated = (file: string): ChangeClosure => ({ symbols: [{ file, symbol: "nativeOnlyGuard" }], complete: true });
  const run = (closure: ChangeClosure) =>
    classifyWith({
      route: "/upload-menu/preview",
      head: { ...ALIASED, [ROUTES_FILE]: aliasedRoutes(true) },
      base: { [ROUTES_FILE]: aliasedRoutes(true) },
      changed: ["src/app/home/home.page.ts"],
      closure,
    });
  const clear = await run({ symbols: [{ file: "src/app/home/home.page.ts", symbol: "HomePage" }], complete: true });
  assert.equal(clear?.class, "pre-existing");
  /* A symbol of the same name at the barrel is not the guard: the barrel only re-exports it. */
  assert.equal((await run(unrelated("src/app/core/guards/index.ts")))?.class, "pre-existing");
});

const linksOf = (basis: { class: string } | undefined): readonly string[] => (basis?.class === "unexplained" ? ((basis as { links?: readonly string[] }).links ?? []) : []);

test("an unexplained route names the specifier its route table could not resolve", async () => {
  /* The configuration declares no `paths`, so the aliased import of the guard and of the path constant resolve to nothing. */
  const basis = await classifyWith({
    route: "/upload-menu/preview",
    head: { ...ALIASED, "tsconfig.json": "{}", [ROUTES_FILE]: aliasedRoutes(true) },
    base: { [ROUTES_FILE]: aliasedRoutes(false) },
    changed: [ROUTES_FILE],
  });
  assert.equal(basis?.class, "unexplained");
  const links = linksOf(basis);
  assert.ok(links.some((link) => link.includes("@core/router/models/routes.model") && link.includes(ROUTES_FILE)), `links: ${links.join(" | ")}`);
  assert.ok(links.some((link) => link.includes("nativeOnlyGuard") && link.includes("@core/guards")), `links: ${links.join(" | ")}`);
});

test("an unexplained route says why there is no route table at all", async () => {
  const basis = await classifyWith({ head: { [ROUTES_FILE]: aliasedRoutes(true) }, changed: [ROUTES_FILE], crossRepo: true });
  assert.equal(basis?.class, "unexplained");
  assert.ok(linksOf(basis).some((link) => link.includes("another repository")), `links: ${linksOf(basis).join(" | ")}`);
});

test("an unexplained route names the loadChildren it could not follow and the guard it could not place", async () => {
  const routes = [
    "import { Routes } from '@angular/router';",
    "import { guestGuard } from './auth';",
    "const loginFeature = wire(import('./a'), import('./b'));",
    "export const routes: Routes = [",
    "  { path: 'login', canActivate: [guestGuard], loadChildren: loginFeature.loadChildren },",
    "];",
    "",
  ].join("\n");
  const basis = await classifyWith({
    route: "/login/step",
    head: { "src/app/app.routes.ts": routes, "src/app/auth/index.ts": "export * from './missing';\n" },
    base: { "src/app/app.routes.ts": routes },
    changed: ["src/app/app.routes.ts"],
    closure: { symbols: [], complete: true },
  });
  const links = linksOf(basis);
  assert.ok(links.some((link) => link.includes("loadChildren") && link.includes("loginFeature")), `links: ${links.join(" | ")}`);
  assert.ok(links.some((link) => link.includes("guestGuard")), `links: ${links.join(" | ")}`);
});
