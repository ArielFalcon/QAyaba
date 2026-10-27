/* deriveCandidates: a reach entry made testable. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCandidates, type ChangeScope, type ReachEntry } from "@contexts/change-analysis/application/index.ts";
import { candidateLine } from "@kernel/use-case-candidate.ts";

const WEB = "org/web";
const API = "org/api";
const SEED = { file: "web/src/format.ts", symbol: "formatMoney", range: { start: 1, end: 5 } };

const page = (route: string, over: Partial<ReachEntry> = {}): ReachEntry => ({ entry: { kind: "page", repo: WEB, route }, tier: "direct", basis: "implementation", evidence: [`web/src/${route.slice(1)}.ts::view`, `page ${route}`], seeds: [SEED], confidence: 1, ...over });
const operation = (verb: string, path: string, over: Partial<ReachEntry> = {}): ReachEntry => ({ entry: { kind: "operation", repo: API, verb, path }, tier: "cross-repo", basis: "contract", evidence: [`${API}: ${verb} ${path}`], seeds: [], confidence: 1, ...over });
const scopeOf = (reach: ReachEntry[]): ChangeScope => ({ repos: [], reach, hubs: [], disagreements: [], omitted: 0, degraded: [] });

test("a page entry is a page candidate that keeps its tier, evidence and seeds", () => {
  const [c] = deriveCandidates(scopeOf([page("/orders", { tier: "indirect", basis: "graph", confidence: 0.5 })]));

  assert.equal(c!.reachability, "page");
  assert.equal(c!.tier, "indirect");
  assert.equal(c!.basis, "graph");
  assert.equal(c!.confidence, 0.5);
  assert.deepEqual(c!.evidence, ["web/src/orders.ts::view", "page /orders"]);
  assert.deepEqual(c!.seeds, [SEED]);
});

test("an operation no page reaches is backend-only; one a page reaches through a call site is via-page with that page", () => {
  const lonely = deriveCandidates(scopeOf([operation("GET", "/api/ping")]));
  assert.equal(lonely[0]!.reachability, "backend-only");
  assert.deepEqual(lonely[0]!.pages, []);

  const viaCallSite = deriveCandidates(scopeOf([
    operation("GET", "/api/orders"),
    page("/orders", { tier: "cross-repo", basis: "call-site", evidence: [`${API}: GET /api/orders`, "web/src/orders.ts::load", "page /orders"] }),
  ]));
  const op = viaCallSite.find((c) => c.entry.kind === "operation")!;
  assert.equal(op.reachability, "via-page");
  assert.deepEqual(op.pages, ["/orders"]);
});

test("an operation the map joins to a page is via-page through that page", () => {
  const map = { api: [{ operationId: "listOrders", method: "get", path: "/api/orders" }], feBe: [{ route: "/orders", operationId: "listOrders" }, { route: "/cart", operationId: "other" }] };

  const [c] = deriveCandidates(scopeOf([operation("GET", "/api/orders")]), { map });

  assert.equal(c!.reachability, "via-page");
  assert.deepEqual(c!.pages, ["/orders"]);
});

test("without a map or a suite the candidates exist from the scope alone, with no label and no existing specs", () => {
  const [c] = deriveCandidates(scopeOf([page("/orders")]));

  assert.equal(c!.label, undefined);
  assert.deepEqual(c!.existingSpecs, []);
});

test("the label is the map's name for the page", () => {
  const [c] = deriveCandidates(scopeOf([page("/orders")]), { map: { routes: [{ path: "/orders", name: "Orders list" }] } });

  assert.equal(c!.label, "Orders list");
});

test("a page the map links to a changed file becomes a direct candidate when the scope does not hold it", () => {
  const all = deriveCandidates(scopeOf([page("/orders")]), { mapLinks: [{ repo: WEB, route: "/orders", basis: "source", files: ["web/src/orders.ts"] }, { repo: WEB, route: "/profile", basis: "spec", files: ["web/src/profile.html"] }] });

  assert.deepEqual(all.map((c) => c.entry.kind === "page" ? c.entry.route : ""), ["/orders", "/profile"]);
  const profile = all.find((c) => c.entry.kind === "page" && c.entry.route === "/profile")!;
  assert.equal(profile.tier, "direct");
  assert.equal(profile.basis, "spec");
  assert.equal(all.find((c) => c.entry.kind === "page" && c.entry.route === "/orders")!.basis, "implementation", "the scope's own entry is kept");
});

test("existing specs are those whose manifest targets name the route or whose use case names the label, and the suite files that open the route", () => {
  const manifest = [
    { file: "e2e/orders.spec.ts", targets: ["https://dev.example.test/orders?x=1"] },
    { file: "e2e/cart.spec.ts", targets: ["/cart"] },
    { file: "e2e/named.spec.ts", useCase: "Orders list", targets: ["/somewhere"] },
  ];
  const suiteFiles = [{ file: "e2e/opens.spec.ts", text: "await page.goto('/orders');" }, { file: "e2e/other.spec.ts", text: "await page.goto('/ordersheet');" }, { file: "e2e/tpl.spec.ts", text: "await page.goto(`/shops/7`);" }];

  const [orders] = deriveCandidates(scopeOf([page("/orders")]), { map: { routes: [{ path: "/orders", name: "Orders list" }] }, manifest, suiteFiles });
  assert.deepEqual(orders!.existingSpecs, ["e2e/named.spec.ts", "e2e/opens.spec.ts", "e2e/orders.spec.ts"]);

  const [shop] = deriveCandidates(scopeOf([page("/shops/:id")]), { suiteFiles });
  assert.deepEqual(shop!.existingSpecs, ["e2e/tpl.spec.ts"]);
});

test("an operation's existing specs are those whose manifest targets name its verb and path", () => {
  const [c] = deriveCandidates(scopeOf([operation("POST", "/api/orders")]), { manifest: [{ file: "e2e/a.spec.ts", targets: ["post /api/orders"] }, { file: "e2e/b.spec.ts", targets: ["GET /api/orders"] }] });

  assert.deepEqual(c!.existingSpecs, ["e2e/a.spec.ts"]);
});

test("the candidate line says what each existing spec declares it checks, so the lead need not open it", () => {
  const manifest = [
    { file: "e2e/orders.spec.ts", objective: "an order\n placed shows in the list", targets: ["/orders"] },
    { file: "e2e/orders.spec.ts", objective: "an empty list says so", targets: ["/orders"] },
    { file: "e2e/opens.spec.ts", targets: ["/orders"] },
  ];
  const [c] = deriveCandidates(scopeOf([page("/orders")]), { manifest });

  const line = candidateLine(c!);
  assert.match(line, /specs: e2e\/opens\.spec\.ts, e2e\/orders\.spec\.ts \(declares: an order placed shows in the list; an empty list says so\)/);
});

test("a declared objective is cut to a bounded length in the candidate line", () => {
  const [c] = deriveCandidates(scopeOf([page("/orders")]), { manifest: [{ file: "e2e/orders.spec.ts", objective: "x".repeat(1000), targets: ["/orders"] }] });

  assert.ok(candidateLine(c!).length < 600);
  assert.match(candidateLine(c!), /\(declares: x+\.\.\.\)/);
});

test("ids are stable across input order and differ per entry point", () => {
  const a = page("/orders");
  const b = page("/profile", { tier: "indirect", basis: "graph" });
  const c = operation("GET", "/api/orders");

  const forward = deriveCandidates(scopeOf([a, b, c]));
  const backward = deriveCandidates(scopeOf([c, b, a]));

  assert.deepEqual(forward, backward);
  assert.match(forward[0]!.id, /^uc-[0-9a-f]{8}$/);
  assert.equal(new Set(forward.map((x) => x.id)).size, 3);
  assert.equal(deriveCandidates(scopeOf([a]))[0]!.id, forward.find((x) => x.entry.kind === "page" && x.entry.route === "/orders")!.id);
});

test("candidates come ordered direct, then indirect, then cross-repo", () => {
  const out = deriveCandidates(scopeOf([
    page("/x", { tier: "cross-repo", basis: "call-site" }),
    page("/y", { tier: "indirect", basis: "graph" }),
    page("/z", { tier: "direct" }),
  ]));

  assert.deepEqual(out.map((c) => c.tier), ["direct", "indirect", "cross-repo"]);
});

test("a page the map links to changed files is seeded by those files, whole, and shows them with the lines the change added", () => {
  const scope: ChangeScope = { ...scopeOf([]), repos: [{ repo: WEB, role: "primary", indexedSha: null, changedFiles: [], seeds: [], seedBasis: "none", addedLines: { "web/src/profile.scss": 12 }, entryPoints: [], entryPointsTruncated: false }] };

  const [c] = deriveCandidates(scope, { mapLinks: [{ repo: WEB, route: "/profile", basis: "implementation", files: ["web/src/profile.scss", "web/src/profile.ts"] }] });

  assert.deepEqual(c!.seeds.map((s) => [s.file, s.range]), [["web/src/profile.scss", undefined], ["web/src/profile.ts", undefined]]);
  assert.deepEqual(c!.changedFiles, [{ file: "web/src/profile.scss", addedLines: 12 }, { file: "web/src/profile.ts" }]);
});

test("a candidate the call graph proved keeps its seeds and lists their files once", () => {
  const seeds = [SEED, { ...SEED, symbol: "other", range: { start: 9, end: 12 } }];
  const [c] = deriveCandidates(scopeOf([page("/orders", { seeds })]));

  assert.deepEqual(c!.seeds, seeds);
  assert.deepEqual(c!.changedFiles, [{ file: SEED.file }]);
});

test("the candidate line names the changed files with their kind and added lines, and says nothing about files when none seeds it", () => {
  const withFiles = candidateLine({ ...deriveCandidates(scopeOf([page("/orders")]))[0]!, changedFiles: [{ file: "web/src/a.scss", addedLines: 7 }, { file: "web/src/a.ts", addedLines: 2 }, { file: "b.java" }] });
  assert.match(withFiles, /web\/src\/a\.scss \(other, \+7\)/);
  assert.match(withFiles, /web\/src\/a\.ts \(typescript, \+2\)/);
  assert.match(withFiles, /b\.java \(java\)/);

  assert.doesNotMatch(candidateLine({ ...deriveCandidates(scopeOf([page("/orders")]))[0]!, changedFiles: [] }), /changed:/);
});
