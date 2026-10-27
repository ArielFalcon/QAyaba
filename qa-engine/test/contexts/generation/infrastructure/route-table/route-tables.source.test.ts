import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { routeTablesOf } from "@contexts/generation/infrastructure/route-table/route-tables.source.ts";
import { declarationEvidence, guardEvidence, guardsOf, matchRoute } from "@contexts/generation/domain/route-table.ts";

/* A synthetic Angular repo: a root table with a guarded lazy section, a login page, a fallback; paths from a constant. */
const PACKAGE = JSON.stringify({ dependencies: { "@angular/core": "20.0.0", "@angular/router": "20.0.0" } });
const PATHS = "export const RoutePath = {\n  Home: 'home',\n  Login: 'login',\n  Upload: 'upload-menu',\n} as const;\n";
const UPLOAD = "import { Routes } from '@angular/router';\n\nexport const UPLOAD_ROUTES: Routes = [\n  { path: 'preview', component: PreviewPage },\n  { path: 'confirm', component: ConfirmPage },\n];\n";
const GUARD = "export const nativeOnlyGuard = () => isNative();\n";

const routesFile = (opts: { guarded: boolean; legacy?: boolean; earlierLogin?: boolean; fallbackTo?: string }): string => [
  "import { RoutePath } from './route-paths';",
  ...(opts.guarded ? ["import { nativeOnlyGuard } from './guards/native-only.guard';"] : []),
  "import { guestGuard } from './guards/guest.guard';",
  "import { initialRouteGuard } from './guards/initial.guard';",
  "",
  "export const routes: AppRoutes = [",
  "  { path: '', canActivate: [initialRouteGuard], pathMatch: 'full', component: StartPage },",
  ...(opts.earlierLogin ? ["  { path: RoutePath.Login, canMatch: [guestGuard], component: OtherLoginPage },"] : []),
  "  {",
  "    path: RoutePath.Login,",
  "    canActivate: [guestGuard],",
  "    component: LoginPage,",
  "  },",
  "  { path: RoutePath.Home, component: HomePage },",
  ...(opts.legacy ? ["  { path: 'legacy', component: LegacyPage },"] : []),
  "  {",
  "    path: RoutePath.Upload,",
  ...(opts.guarded ? ["    canMatch: [nativeOnlyGuard],"] : []),
  "    loadChildren: () => import('./upload/upload.routes').then((m) => m.UPLOAD_ROUTES),",
  "  },",
  `  { path: '**', redirectTo: ${opts.fallbackTo ?? "RoutePath.Home"} },`,
  "];",
  "",
].join("\n");

function repoWith(head: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "route-tables-"));
  for (const [file, text] of Object.entries(head)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const common = { "package.json": PACKAGE, "src/app/route-paths.ts": PATHS, "src/app/upload/upload.routes.ts": UPLOAD, "src/app/guards/native-only.guard.ts": GUARD };

async function tablesFor(head: string, base: string | undefined, extra: Record<string, string> = {}) {
  const dir = repoWith({ ...common, ...extra, "src/app/app.routes.ts": head });
  try {
    return await routeTablesOf({ mirrorDir: dir, changedFiles: ["src/app/app.routes.ts"], readAtBase: async (file) => (file === "src/app/app.routes.ts" ? base : undefined) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a guard added to a section's declaration changes the routes below it, and only those", async () => {
  const tables = await tablesFor(routesFile({ guarded: true }), routesFile({ guarded: false }));
  assert.ok(tables);
  assert.deepEqual(declarationEvidence(tables.head, tables.base, "/upload-menu/preview"), { status: "changed", at: "src/app/app.routes.ts:14" });
  assert.deepEqual(declarationEvidence(tables.head, tables.base, "/upload-menu/confirm"), { status: "changed", at: "src/app/app.routes.ts:14" });
  /* The import lines and the guard's line changed the file, not the entries that decide these routes. */
  assert.deepEqual(declarationEvidence(tables.head, tables.base, "/login"), { status: "unchanged", at: "src/app/app.routes.ts:8" });
  assert.deepEqual(declarationEvidence(tables.head, tables.base, "/"), { status: "unchanged", at: "src/app/app.routes.ts:7" });
});

test("a route's guards are its own and its parents', placed at the file that declares them", async () => {
  const tables = await tablesFor(routesFile({ guarded: true }), routesFile({ guarded: false }));
  const match = matchRoute(tables!.head, "/upload-menu/preview");
  assert.ok(match && "steps" in match);
  assert.deepEqual(guardsOf(match), [{ name: "nativeOnlyGuard", file: "src/app/guards/native-only.guard.ts" }]);
});

test("a route present at the base and gone at head is changed by the change", async () => {
  const tables = await tablesFor(routesFile({ guarded: false }), routesFile({ guarded: false, legacy: true }));
  assert.deepEqual(declarationEvidence(tables!.head, tables!.base, "/legacy"), { status: "changed", at: "src/app/app.routes.ts:13 (removed at head)" });
});

test("an entry added before a route that takes its address changes the route", async () => {
  const tables = await tablesFor(routesFile({ guarded: false, earlierLogin: true }), routesFile({ guarded: false }));
  assert.deepEqual(declarationEvidence(tables!.head, tables!.base, "/login"), { status: "changed", at: "src/app/app.routes.ts:7" });
});

test("a changed fallback leaves a route that took its own entry undecided", async () => {
  const tables = await tablesFor(routesFile({ guarded: false, fallbackTo: "'/start'" }), routesFile({ guarded: false }));
  assert.deepEqual(declarationEvidence(tables!.head, tables!.base, "/home"), { status: "unknown" });
});

test("a section loaded from a module the extractor cannot read is unknown", async () => {
  const head = routesFile({ guarded: false }).replace("./upload/upload.routes", "./upload/missing.routes");
  const tables = await tablesFor(head, head);
  assert.deepEqual(declarationEvidence(tables!.head, tables!.base, "/upload-menu/preview"), { status: "unknown" });
});

test("a repository whose manifest names no framework with an extractor has no route table", async () => {
  const tables = await tablesFor(routesFile({ guarded: false }), routesFile({ guarded: false }), { "package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }) });
  assert.equal(tables, undefined);
});

test("a changed symbol reaching a listed guard reaches the route; a complete closure without it proves it unreached", () => {
  const guards = [{ name: "nativeOnlyGuard", file: "src/app/guards/native-only.guard.ts" }];
  assert.deepEqual(guardEvidence(guards, { symbols: [{ file: "src/app/guards/native-only.guard.ts", symbol: "nativeOnlyGuard" }], complete: false }), { status: "reached", at: "src/app/guards/native-only.guard.ts::nativeOnlyGuard" });
  assert.deepEqual(guardEvidence(guards, { symbols: [], complete: true }), { status: "unreached" });
  assert.deepEqual(guardEvidence(guards, { symbols: [], complete: false }), { status: "partial" });
  assert.equal(guardEvidence(guards, undefined), undefined);
  assert.deepEqual(guardEvidence([{ name: "aliasGuard" }], { symbols: [], complete: true }), { status: "partial" });
  assert.deepEqual(guardEvidence([], undefined), { status: "unreached" });
});
