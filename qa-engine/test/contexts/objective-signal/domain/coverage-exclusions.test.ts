import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changedCodeFiles,
  diffWithoutFiles,
  excludedFilesOf,
  testSupportFiles,
  unreachableByDesign,
  type ReachScope,
} from "@contexts/objective-signal/domain/coverage-exclusions.ts";
import { FILE_SEED_SYMBOL, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";
import type { ImportersReport } from "@kernel/code/index.ts";

const PREVIEW = "src/app/upload-menu/preview.page.ts";

const page = (route: string, seeds: Array<{ file: string; symbol: string }>, extra: Partial<UseCaseCandidate> = {}): UseCaseCandidate => ({
  id: `uc-${route}`,
  entry: { kind: "page", repo: "o/app", route },
  tier: "direct",
  basis: "graph",
  evidence: [],
  seeds,
  confidence: 1,
  reachability: "page",
  pages: [],
  existingSpecs: [],
  ...extra,
});

const fact = (route: string, cls: "change-introduced" | "pre-existing" | "unexplained", extra: Partial<RouteAvailabilityFact> = {}): RouteAvailabilityFact => ({
  route,
  outcome: { kind: "redirected", to: "/home", mechanism: "client" },
  basis:
    cls === "change-introduced"
      ? { class: "change-introduced", via: "route-declaration", at: "src/app.routes.ts:10" }
      : cls === "pre-existing"
        ? { class: "pre-existing", why: "unchanged" }
        : { class: "unexplained", missing: ["declaration"] },
  ...extra,
});

const scope = (seeds: Array<{ file: string; symbol: string }>, extra: Partial<ReachScope> = {}): ReachScope => ({
  repos: [{ seeds }],
  hubs: [],
  omitted: 0,
  degraded: [],
  ...extra,
});

const SEED = { file: PREVIEW, symbol: "PreviewPage" };

test("a file only reached through routes the change made unavailable is unreachable by design, with those routes", () => {
  const out = unreachableByDesign({
    files: [PREVIEW],
    scope: scope([SEED]),
    candidates: [page("/upload-menu/preview", [SEED])],
    facts: [fact("/upload-menu/preview", "change-introduced")],
  });
  assert.deepEqual(out, [{ file: PREVIEW, routes: ["/upload-menu/preview"] }]);
});

test("a route template is matched to the fact of the page the capture opened through it", () => {
  const out = unreachableByDesign({
    files: [PREVIEW],
    scope: scope([SEED]),
    candidates: [page("/shops/:city/preview", [SEED])],
    facts: [fact("/shops/madrid/preview", "change-introduced", { template: "/shops/:city/preview" })],
  });
  assert.deepEqual(out.map((e) => e.file), [PREVIEW]);
});

test("a file reached by an unavailable route and by an available one stays counted", () => {
  const out = unreachableByDesign({
    files: [PREVIEW],
    scope: scope([SEED]),
    candidates: [page("/upload-menu/preview", [SEED]), page("/home", [SEED])],
    facts: [fact("/upload-menu/preview", "change-introduced")],
  });
  assert.deepEqual(out, []);
});

test("a route that was unavailable before the change, or that nothing explains, is not unavailable by the change's design", () => {
  for (const cls of ["pre-existing", "unexplained"] as const) {
    const out = unreachableByDesign({ files: [PREVIEW], scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED])], facts: [fact("/upload-menu/preview", cls)] });
    assert.deepEqual(out, [], cls);
  }
});

test("a file an operation or a page with no fact also reaches stays counted", () => {
  const operation: UseCaseCandidate = { ...page("/x", [SEED]), entry: { kind: "operation", repo: "o/app", verb: "GET", path: "/api/menu" }, reachability: "via-page" };
  const facts = [fact("/upload-menu/preview", "change-introduced")];
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED]), operation], facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED]), page("/other", [SEED])], facts }), []);
});

test("a changed symbol of the file that reaches no use case keeps the file counted", () => {
  const dead = { file: PREVIEW, symbol: "helperNobodyCalls" };
  const out = unreachableByDesign({ files: [PREVIEW], scope: scope([SEED, dead]), candidates: [page("/upload-menu/preview", [SEED])], facts: [fact("/upload-menu/preview", "change-introduced")] });
  assert.deepEqual(out, []);
});

test("a map-linked whole-file seed stands for every symbol of the file", () => {
  const whole = { file: PREVIEW, symbol: FILE_SEED_SYMBOL };
  const out = unreachableByDesign({ files: [PREVIEW], scope: scope([SEED]), candidates: [page("/upload-menu/preview", [whole])], facts: [fact("/upload-menu/preview", "change-introduced")] });
  assert.deepEqual(out.map((e) => e.file), [PREVIEW]);
});

test("a partial seed, a hub, a cut reach list or a degraded index leave the file counted: the facts are partial", () => {
  const candidates = [page("/upload-menu/preview", [SEED])];
  const facts = [fact("/upload-menu/preview", "change-introduced")];
  const key = `${SEED.file}::${SEED.symbol}`;
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED], { partialSeeds: [key] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED], { hubs: [{ symbol: key, seeds: [] }] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED], { hubs: [{ symbol: "x::Node", seeds: [key] }] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED], { omitted: 3 }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED], { degraded: [{ repo: "o/app" }] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: undefined, candidates, facts }), []);
});

test("a file no use case is seeded in, or with no fact of its routes at all, stays counted", () => {
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED]), candidates: [], facts: [fact("/upload-menu/preview", "change-introduced")] }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED])], facts: [] }), []);
});

const report = (...files: ImportersReport["files"]): ImportersReport => ({ indexedSha: "abc", files });

test("a file every importer of which is a test file is test support", () => {
  const out = testSupportFiles(report({ file: "src/store.spec-helper.ts", indexed: true, importers: ["src/a.spec.ts", "src/b.test.ts"], complete: true }));
  assert.deepEqual(out, [{ file: "src/store.spec-helper.ts", importers: 2 }]);
});

test("a file with one importer that is production code, none, a cut list or no place in the index stays counted", () => {
  const out = testSupportFiles(
    report(
      { file: "mixed.ts", indexed: true, importers: ["a.spec.ts", "src/page.ts"], complete: true },
      { file: "unused.ts", indexed: true, importers: [], complete: true },
      { file: "cut.ts", indexed: true, importers: ["a.spec.ts"], complete: false },
      { file: "unknown.ts", indexed: false, importers: [], complete: false },
    ),
  );
  assert.deepEqual(out, []);
  assert.deepEqual(testSupportFiles(undefined), []);
});

test("a file already excluded for another reason is not listed twice", () => {
  const out = testSupportFiles(report({ file: "a.ts", indexed: true, importers: ["a.spec.ts"], complete: true }), new Set(["a.ts"]));
  assert.deepEqual(out, []);
});

test("the diff without excluded files keeps every other section whole", () => {
  const section = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;
  const diff = section("src/a.ts") + section("src/helper.ts") + section("src/b.ts");
  const excluded = excludedFilesOf({ unreachableByDesign: [{ file: "src/a.ts", routes: ["/a"] }], testSupportFiles: [{ file: "src/helper.ts", importers: 1 }] });
  assert.equal(diffWithoutFiles(diff, excluded), section("src/b.ts"));
  assert.equal(diffWithoutFiles(diff, new Set()), diff);
});

test("the changed code files are the commit's own files of a declared language, test files and documents apart", () => {
  const section = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;
  const diff = section("src/a.ts") + section("src/a.spec.ts") + section("README.md") + section("src/card.scss");
  assert.deepEqual(changedCodeFiles(diff), ["src/a.ts"]);
});
