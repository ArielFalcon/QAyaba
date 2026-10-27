/* What the pinned engine extracts from Angular route declarations, read through the store reader (fixture:
   __fixtures__/codegraph-angular-routes/repo.json, lines below are that repo's `src/app/app.routes.ts` unless named).
   The route-availability evidence (a hunk inside a route's declaration, a guard the route references) depends on these
   facts; a re-recorded store that changes one of them fails here first. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { STORE_READER_SCRIPT } from "../../../src/shared-infrastructure/code-graph/codegraph-engine.ts";

const STORE = join(import.meta.dirname, "__fixtures__", "codegraph-angular-routes", "store.db");
const APP_ROUTES = "src/app/app.routes.ts";

interface Route {
  name: string;
  file: string;
  line: number;
  target?: { file: string; symbol: string; kind: string };
}
interface GraphSymbol {
  id: string;
  file: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
}
interface WalkNode {
  file: string;
  symbol: string;
  kind: string;
  depth: number;
}

function read<T>(request: unknown): T {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", STORE_READER_SCRIPT, STORE, JSON.stringify(request)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as T;
}

const routes = (): Route[] => read<{ routes: Route[] }>({ op: "routes" }).routes;
const routeAt = (file: string, line: number): Route | undefined => routes().find((r) => r.file === file && r.line === line);

function symbol(file: string, name: string): GraphSymbol {
  const found = read<{ symbols: GraphSymbol[] }>({ op: "find", symbols: [{ file, symbol: name }] }).symbols;
  assert.equal(found.length, 1, `${file}::${name} is in the store`);
  return found[0]!;
}

test("a route whose path is built from a constant gets a node named by the constant's value", () => {
  assert.equal(routeAt(APP_ROUTES, 31)?.name, "/admin/reports", "a child of `path: RoutePath.Admin`");
  assert.equal(routeAt(APP_ROUTES, 35)?.name, "/login", "`path: RoutePath.Login`");
  assert.equal(routeAt(APP_ROUTES, 20)?.name, "/home-start", "`path: RoutePath.Home + '-start'`");
});

test("a route that names no component (lazy children only, or a redirect) gets no node", () => {
  const lines = new Set(routes().filter((r) => r.file === APP_ROUTES).map((r) => r.line));
  for (const line of [21, 22, 23, 24, 25, 26]) assert.equal(lines.has(line), false, `the loadChildren route with canMatch declares lines 21-26 (line ${line})`);
  assert.equal(lines.has(12), false, "`path: ''` with redirectTo");
  assert.equal(lines.has(36), false, "`path: RoutePath.Legacy` with redirectTo");
  assert.equal(lines.has(37), false, "`path: '**'` with redirectTo");
});

test("only an array typed with the router's Routes declares routes: an alias of Route[] or an untyped array declares none", () => {
  assert.equal(routes().some((r) => r.file === "src/app/shop/shop.routes.ts"), false);
  assert.equal(routeAt(APP_ROUTES, 13)?.name, "/home", "the same component route in a Routes array has a node");
});

test("a lazy component gets a route to it, and a lazily loaded child array carries its parent's path", () => {
  const audit = routeAt(APP_ROUTES, 32);
  assert.equal(audit?.name, "/admin/audit");
  assert.equal(audit?.target?.symbol, "AuditPage", "loadComponent resolves to the component class");
  const preview = routeAt("src/app/upload/upload.routes.ts", 7);
  assert.equal(preview?.name, "/upload/preview", "the prefix comes from the loadChildren route, which has no node of its own");
  assert.equal(preview?.target?.symbol, "PreviewPage");
});

test("a multi-line route declaration is located by its path line alone", () => {
  const login = routeAt(APP_ROUTES, 15);
  assert.equal(login?.name, "/login", "declared over lines 14-18, located at `path: 'login'`");
  assert.equal(login !== undefined && "endLine" in login, false, "no end line is answered for a route");
  const walked = read<{ nodes: (WalkNode & { startLine: number; endLine?: number })[] }>({ op: "walk", seeds: [symbol("src/app/login/login.page.ts", "LoginPage").id], depth: 1 });
  const reached = walked.nodes.find((n) => n.kind === "route" && n.startLine === 15);
  assert.equal(reached?.endLine, undefined, "the walk gives a reached route its start line only");
});

test("a guard is referenced by the array constant that holds the route, never by the route, so no route is reached from it", () => {
  const guardNames = ["nativeOnlyGuard", "authGuard", "guestGuard", "adminChildGuard"];
  assert.equal(routes().some((r) => guardNames.includes(r.target?.symbol ?? "")), false, "a route points at its component only");

  const array = read<{ symbols: GraphSymbol[] }>({ op: "symbols", files: [APP_ROUTES] }).symbols.find((s) => s.symbol === "routes");
  assert.equal(array?.kind, "constant");
  assert.ok(array !== undefined && array.startLine <= 23 && array.endLine >= 23, "the canMatch line falls in the array constant's range, the innermost symbol holding it");

  const seeds = [symbol("src/app/guards/native-only.guard.ts", "nativeOnlyGuard"), symbol("src/app/guards/auth.guard.ts", "authGuard"), symbol("src/app/guards/admin-child.guard.ts", "adminChildGuard")];
  const walked = read<{ nodes: WalkNode[] }>({ op: "walk", seeds: seeds.map((s) => s.id), depth: 3 });
  assert.deepEqual(walked.nodes.filter((n) => n.depth > 0), [], "the walk does not follow the array's reference to a guard");
});

test("a page reached from a changed component reaches its routes at depth 1", () => {
  const walked = read<{ nodes: WalkNode[] }>({ op: "walk", seeds: [symbol("src/app/login/login.page.ts", "LoginPage").id], depth: 3 });
  const reached = walked.nodes.filter((n) => n.kind === "route").map((n) => `${n.symbol}@${n.depth}`).sort();
  assert.deepEqual(reached, ["/login@1", "/login@1"], "both routes to LoginPage (lines 15 and 35)");
});
