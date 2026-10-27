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

const routesFile = (opts: { guarded: boolean; retired?: boolean; earlierLogin?: boolean; fallbackTo?: string }): string => [
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
  ...(opts.retired ? ["  { path: 'retired', component: RetiredPage },"] : []),
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
  const tables = await tablesFor(routesFile({ guarded: false }), routesFile({ guarded: false, retired: true }));
  assert.deepEqual(declarationEvidence(tables!.head, tables!.base, "/retired"), { status: "changed", at: "src/app/app.routes.ts:13 (removed at head)" });
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

/* A repo whose specifiers go through the tsconfig: `paths` inherited through an `extends` chain, `baseUrl` imports, renames and barrels. */
async function tablesOf(files: Record<string, string>) {
  const dir = repoWith({ "package.json": PACKAGE, ...files });
  try {
    return await routeTablesOf({ mirrorDir: dir, changedFiles: ["src/app/app.routes.ts"], readAtBase: async (file) => files[file] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GUARD_AT = "src/app/core/guards/native-only.guard.ts";
const guardedEntry = [
  "import { Routes } from '@angular/router';",
  "import { RoutePath as Paths } from '@app/models';",
  "import { nativeOnlyGuard as native } from '@app/guards';",
  "",
  "export const routes: Routes = [",
  "  { path: Paths.Upload, canMatch: [native], loadChildren: () => import('@app/upload').then((m) => m.UPLOAD_ROUTES) },",
  "];",
  "",
].join("\n");
const aliasFiles = {
  "tsconfig.base.json": '{\n  // comments are allowed in a tsconfig\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/core/*", "src/app/features/*"] } }\n}',
  "tsconfig.json": '{ "extends": "./tsconfig.base.json" }',
  "src/app/core/models/index.ts": "export * from './routes.model';\n",
  "src/app/core/models/routes.model.ts": "export enum RoutePath {\n  Upload = 'upload-menu',\n}\n",
  "src/app/core/guards/index.ts": "export { nativeOnlyGuard } from './native-only.guard';\n",
  [GUARD_AT]: "export const nativeOnlyGuard = () => isNative();\n",
  "src/app/features/upload/index.ts": "export { UPLOAD_ROUTES } from './upload.routes';\n",
  "src/app/features/upload/upload.routes.ts": "export const UPLOAD_ROUTES: Routes = [\n  { path: 'preview', component: PreviewPage },\n];\n",
  "src/app/app.routes.ts": guardedEntry,
};

test("paths inherited through extends, renames and barrels resolve a path, a guard and a lazy table to their declarations", async () => {
  const tables = await tablesOf(aliasFiles);
  const match = matchRoute(tables!.head, "/upload-menu/preview");
  assert.ok(match && "steps" in match);
  assert.deepEqual(guardsOf(match), [{ name: "nativeOnlyGuard", file: GUARD_AT }]);
});

test("a specifier the configuration does not resolve leaves the path and the guard of its entry unresolved", async () => {
  const withoutPaths = { ...aliasFiles, "tsconfig.base.json": '{ "compilerOptions": { "baseUrl": "." } }' };
  const tables = await tablesOf(withoutPaths);
  assert.deepEqual(declarationEvidence(tables!.head, tables!.base, "/upload-menu/preview"), { status: "unknown" });
  const none = await tablesOf({ ...aliasFiles, "tsconfig.json": "{}" });
  assert.deepEqual(declarationEvidence(none!.head, none!.base, "/upload-menu/preview"), { status: "unknown" });
});

test("baseUrl alone resolves an import written from the repository root, and a package dependency stays external", async () => {
  const routes = [
    "import { Routes } from '@angular/router';",
    "import { RoutePath } from 'src/app/models/routes.model';",
    "import { shellGuard } from '@angular/router';",
    "export const routes: Routes = [",
    "  { path: RoutePath.Upload, canActivate: [shellGuard], component: UploadPage },",
    "];",
    "",
  ].join("\n");
  const tables = await tablesOf({
    "tsconfig.json": '{ "compilerOptions": { "baseUrl": "." } }',
    "src/app/models/routes.model.ts": "export enum RoutePath {\n  Upload = 'upload-menu',\n}\n",
    "src/app/app.routes.ts": routes,
  });
  const match = matchRoute(tables!.head, "/upload-menu");
  assert.ok(match && "steps" in match);
  assert.deepEqual(guardsOf(match), [{ name: "shellGuard", external: true }]);
});
