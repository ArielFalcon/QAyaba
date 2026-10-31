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

/* PreviewPage spans lines 5-40 and the commit adds lines 10-14 to the file. */
const SEED = { file: PREVIEW, symbol: "PreviewPage", range: { start: 5, end: 40 } };
/* One diff section for the file, one hunk per [first line, count] pair. */
const addedAt = (file: string, ...hunks: Array<[number, number]>): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks.map(([start, count]) => `@@ -0,0 +${start},${count} @@\n${"+x\n".repeat(count)}`).join("")}`;
const DIFF = addedAt(PREVIEW, [10, 5]);

test("a file only reached through routes the change made unavailable is unreachable by design, with those routes", () => {
  const out = unreachableByDesign({
    files: [PREVIEW], diff: DIFF,
    scope: scope([SEED]),
    candidates: [page("/upload-menu/preview", [SEED])],
    facts: [fact("/upload-menu/preview", "change-introduced")],
  });
  assert.deepEqual(out, [{ file: PREVIEW, routes: ["/upload-menu/preview"] }]);
});

test("a route template is matched to the fact of the page the capture opened through it", () => {
  const out = unreachableByDesign({
    files: [PREVIEW], diff: DIFF,
    scope: scope([SEED]),
    candidates: [page("/shops/:city/preview", [SEED])],
    facts: [fact("/shops/madrid/preview", "change-introduced", { template: "/shops/:city/preview" })],
  });
  assert.deepEqual(out.map((e) => e.file), [PREVIEW]);
});

test("a file reached by an unavailable route and by an available one stays counted", () => {
  const out = unreachableByDesign({
    files: [PREVIEW], diff: DIFF,
    scope: scope([SEED]),
    candidates: [page("/upload-menu/preview", [SEED]), page("/home", [SEED])],
    facts: [fact("/upload-menu/preview", "change-introduced")],
  });
  assert.deepEqual(out, []);
});

test("a route that was unavailable before the change, or that nothing explains, is not unavailable by the change's design", () => {
  for (const cls of ["pre-existing", "unexplained"] as const) {
    const out = unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED])], facts: [fact("/upload-menu/preview", cls)] });
    assert.deepEqual(out, [], cls);
  }
});

test("a file an operation or a page with no fact also reaches stays counted", () => {
  const operation: UseCaseCandidate = { ...page("/x", [SEED]), entry: { kind: "operation", repo: "o/app", verb: "GET", path: "/api/menu" }, reachability: "via-page" };
  const facts = [fact("/upload-menu/preview", "change-introduced")];
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED]), operation], facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED]), page("/other", [SEED])], facts }), []);
});

test("a changed symbol of the file that reaches no use case keeps the file counted", () => {
  const dead = { file: PREVIEW, symbol: "helperNobodyCalls" };
  const out = unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED, dead]), candidates: [page("/upload-menu/preview", [SEED])], facts: [fact("/upload-menu/preview", "change-introduced")] });
  assert.deepEqual(out, []);
});

test("a map-linked whole-file seed vouches for no symbol: a changed symbol no use case reaches keeps the file counted", () => {
  const whole = { file: PREVIEW, symbol: FILE_SEED_SYMBOL };
  const facts = [fact("/upload-menu/preview", "change-introduced")];
  const native = { file: PREVIEW, symbol: "NativeOnlyPage", range: { start: 5, end: 40 } };
  const unreached = { file: PREVIEW, symbol: "Unreached", range: { start: 41, end: 60 } };
  const diff = addedAt(PREVIEW, [10, 5], [45, 2]);
  const candidates = [page("/upload-menu/preview", [native, whole])];

  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([native, unreached]), candidates, facts }), [], "a symbol only the whole-file seed stands for");
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff, scope: scope([native, unreached]), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([native]), candidates, facts }).map((e) => e.file), [PREVIEW], "every changed symbol is reached by name");
});

test("a whole-file seed alone, with no symbol of the file in the scope, leaves nothing to vouch for the changed lines", () => {
  const whole = { file: PREVIEW, symbol: FILE_SEED_SYMBOL };
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([]), candidates: [page("/upload-menu/preview", [whole])], facts: [fact("/upload-menu/preview", "change-introduced")] }), []);
});

test("a changed line outside every reached symbol keeps the file counted", () => {
  const candidates = [page("/upload-menu/preview", [SEED])];
  const facts = [fact("/upload-menu/preview", "change-introduced")];
  /* a module-level statement after the class, such as a registration call, seeds nothing */
  const diff = addedAt(PREVIEW, [10, 2], [41, 1]);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff, scope: scope([SEED]), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: addedAt(PREVIEW, [10, 2]), scope: scope([SEED]), candidates, facts }).map((e) => e.file), [PREVIEW], "the same file, its changed lines all inside the symbol");
});

test("a seed with no range, or no changed lines to read, keeps the file counted", () => {
  const candidates = [page("/upload-menu/preview", [SEED])];
  const facts = [fact("/upload-menu/preview", "change-introduced")];
  const bare = { file: PREVIEW, symbol: "PreviewPage" };
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([bare]), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: "", scope: scope([SEED]), candidates, facts }), []);
});

test("a partial seed, a hub, a cut reach list or a degraded index leave the file counted: the facts are partial", () => {
  const candidates = [page("/upload-menu/preview", [SEED])];
  const facts = [fact("/upload-menu/preview", "change-introduced")];
  const key = `${SEED.file}::${SEED.symbol}`;
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED], { partialSeeds: [key] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED], { hubs: [{ symbol: key, seeds: [] }] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED], { hubs: [{ symbol: "x::Node", seeds: [key] }] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED], { omitted: 3 }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED], { degraded: [{ repo: "o/app" }] }), candidates, facts }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: undefined, candidates, facts }), []);
});

test("a file no use case is seeded in, or with no fact of its routes at all, stays counted", () => {
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED]), candidates: [], facts: [fact("/upload-menu/preview", "change-introduced")] }), []);
  assert.deepEqual(unreachableByDesign({ files: [PREVIEW], diff: DIFF, scope: scope([SEED]), candidates: [page("/upload-menu/preview", [SEED])], facts: [] }), []);
});

const report = (files: ImportersReport["files"], dynamicLoaders: ImportersReport["dynamicLoaders"] = { files: [], complete: true }): ImportersReport => ({ indexedSha: "abc", files, dynamicLoaders });
const used = (file: string, by: { importers: string[]; users?: string[]; namedBy?: string[]; complete?: boolean }): ImportersReport["files"][number] => ({
  file,
  indexed: true,
  importers: by.importers,
  users: by.users ?? by.importers,
  namedBy: by.namedBy ?? [],
  complete: by.complete ?? true,
});

test("a file every user of which is a test file is test support", () => {
  const out = testSupportFiles(report([used("src/store.spec-helper.ts", { importers: ["src/a.spec.ts", "src/b.test.ts"] })]));
  assert.deepEqual(out, [{ file: "src/store.spec-helper.ts", importers: 2 }]);
});

test("a file with one importer that is production code, none, a cut list or no place in the index stays counted", () => {
  const out = testSupportFiles(
    report([
      used("mixed.ts", { importers: ["a.spec.ts", "src/page.ts"] }),
      used("unused.ts", { importers: [] }),
      used("cut.ts", { importers: ["a.spec.ts"], complete: false }),
      { file: "unknown.ts", indexed: false, importers: [], users: [], namedBy: [], complete: false },
    ]),
  );
  assert.deepEqual(out, []);
  assert.deepEqual(testSupportFiles(undefined), []);
});

test("a production file that uses the file without importing it keeps it counted: a same-package class, by an edge of another kind or by a name the index could not resolve", () => {
  const out = testSupportFiles(
    report([
      used("src/main/Helper.java", { importers: ["src/test/HelperTest.java"], users: ["src/main/Service.java", "src/test/HelperTest.java"] }),
      used("src/main/Util.java", { importers: ["src/test/UtilTest.java"], namedBy: ["src/main/Other.java"] }),
    ]),
  );
  assert.deepEqual(out, []);
});

test("a production file that loads modules by a name the index cannot resolve keeps every file counted: it may load any of them", () => {
  const lazy = used("src/app/lazy/lazy.component.ts", { importers: ["src/app/lazy/lazy.component.spec.ts"] });
  assert.deepEqual(testSupportFiles(report([lazy], { files: ["src/app/app.routes.ts"], complete: true })), []);
  assert.deepEqual(testSupportFiles(report([lazy], { files: [], complete: false })), [], "a cut list of loaders");
  assert.deepEqual(testSupportFiles(report([lazy], { files: ["src/app/x.spec.ts"], complete: true })).map((e) => e.file), ["src/app/lazy/lazy.component.ts"], "a test that loads dynamically proves nothing against it");
});

test("a file already excluded for another reason is not listed twice", () => {
  const out = testSupportFiles(report([used("a.ts", { importers: ["a.spec.ts"] })]), new Set(["a.ts"]));
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
